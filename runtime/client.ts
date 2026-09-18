export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type State = string | readonly Json[] | { readonly [key: string]: Json };
export type Criteria = readonly string[] | Readonly<Record<string, string>>;
export type Question =
  | { readonly type: "noul"; readonly instructions: string }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Criteria }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };
export type ChoiceKey<C extends Criteria> = C extends readonly string[] ? C[number] : Extract<keyof C, string>;
export type BooleanAnswer = { type: "noul"; noul: number; confidence: number };
export type ChoiceAnswer<K extends string> = {
  type: "choice"; choice: K; probabilities: Record<K, number>; confidence: number;
};
export type ScoreAnswer = {
  type: "score"; score: number; probabilities: Record<string, number>; confidence: number;
};
export type Answer<Q extends Question> = Q extends { type: "choice"; criteria: infer C extends Criteria }
  ? ChoiceAnswer<ChoiceKey<C>> : Q extends { type: "score" } ? ScoreAnswer : BooleanAnswer;
export type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: Answer<Q[K]> };
export type RequestOptions = { signal?: AbortSignal };
export type GateOptions = RequestOptions & { threshold?: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a nonempty string`);
}

function probability(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number between 0 and 1`);
  }
}

// Reject lossy JSON conversion, such as undefined fields, Dates, NaN, and cycles.
function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("State must contain only plain JSON values");
  }
  if (ancestors.has(value)) throw new TypeError("State must not contain cycles");
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) validateJson(item, ancestors);
  ancestors.delete(value);
}

function labels(criteria: unknown): string[] {
  const keys = Array.isArray(criteria) ? criteria : record(criteria) ? Object.keys(criteria) : [];
  if (keys.length < 2 || keys.length > 32 || new Set(keys).size !== keys.length) {
    throw new TypeError("criteria must contain 2 to 32 distinct options");
  }
  for (const key of keys) text(key, "criterion");
  if (!Array.isArray(criteria) && record(criteria)) {
    for (const description of Object.values(criteria)) text(description, "criterion description");
  }
  return keys;
}

function validateQuestion(question: Question): void {
  if (!record(question)) throw new TypeError("Invalid question");
  text(question.instructions, "instructions");
  if (question.type === "noul") return;
  if (question.type !== "choice" && question.type !== "score") throw new TypeError("Invalid question type");
  if (question.type === "score" && !Array.isArray(question.criteria)) throw new TypeError("A score requires an ordered rubric");
  labels(question.criteria);
}

function readAnswer(raw: unknown, question: Question): BooleanAnswer | ChoiceAnswer<string> | ScoreAnswer {
  if (!record(raw) || raw.type !== question.type) throw new TypeError("Vela returned an unexpected answer type");
  probability(raw.confidence, "confidence");
  if (question.type === "noul") {
    probability(raw.noul, "P(true)");
    return { type: "noul", noul: raw.noul, confidence: raw.confidence };
  }
  const keys = question.type === "choice" ? labels(question.criteria) : question.criteria.map((_, i) => String(i));
  if (!record(raw.probabilities) || Object.keys(raw.probabilities).length !== keys.length) {
    throw new TypeError("Vela returned an invalid probability distribution");
  }
  const rawProbabilities = raw.probabilities;
  const entries = keys.map(key => {
    const p: unknown = Object.hasOwn(rawProbabilities, key) ? rawProbabilities[key] : undefined;
    probability(p, `probability for ${key}`);
    return [key, p] as const;
  });
  // Upstream rounds each probability to four decimal places.
  if (Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) > keys.length * 0.00005 + 0.000001) {
    throw new TypeError("Vela probabilities do not sum to one");
  }
  const probabilities = Object.fromEntries(entries);
  if (question.type === "choice") {
    if (typeof raw.choice !== "string" || !keys.includes(raw.choice)) throw new TypeError("Vela returned an unknown choice");
    return { type: "choice", choice: raw.choice, confidence: raw.confidence, probabilities };
  }
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > keys.length - 1) {
    throw new TypeError("Vela returned a score outside the rubric");
  }
  return { type: "score", score: raw.score, confidence: raw.confidence, probabilities };
}

export class JevAssertionError extends Error {
  constructor(public readonly question: string, public readonly probability: number, public readonly threshold: number) {
    super(`Jev assertion failed: ${question} (P(true)=${probability}, required ${threshold})`);
    this.name = "JevAssertionError";
  }
}

/** Create an async decision function backed by the managed Vela worker. */
export function createJev(config: { endpoint?: string; timeoutMs?: number; token?: string } = {}) {
  const endpoint = new URL(config.endpoint ?? "http://127.0.0.1:8765/predict");
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new TypeError("Expected an HTTP(S) endpoint");
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new TypeError("Invalid timeoutMs");

  async function predict<const Q extends Record<string, Question>>(state: State, questions: Q, options: RequestOptions = {}): Promise<Answers<Q>> {
    if (typeof state !== "string" && !Array.isArray(state) && !record(state)) throw new TypeError("Expected text, an object, or an array as state");
    validateJson(state);
    if (!record(questions) || Object.keys(questions).length === 0 || Object.keys(questions).length > 64) {
      throw new TypeError("Expected 1 to 64 questions");
    }
    // Snapshot questions before awaiting so caller mutation cannot change response validation.
    const snapshot: Q = structuredClone(questions);
    for (const [id, question] of Object.entries(snapshot)) {
      text(id, "question id");
      validateQuestion(question);
    }
    const body = JSON.stringify({ state, questions: snapshot });
    if (new TextEncoder().encode(body).length > 1_048_576) throw new RangeError("Request exceeds 1 MiB");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", ...(config.token ? { "x-jeva-token": config.token } : {}) }, body, signal, redirect: "error",
    });
    if (!response.ok) throw new Error(`Vela request failed with HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!record(payload) || !record(payload.answers)) throw new TypeError("Vela response is missing answers");
    const rawAnswers = payload.answers;
    const answers = Object.fromEntries(Object.entries(snapshot).map(([id, question]) => {
      if (!Object.hasOwn(rawAnswers, id)) throw new TypeError(`Vela response is missing answer ${id}`);
      return [id, readAnswer(rawAnswers[id], question)];
    }));
    // Each result has been checked against its corresponding question above.
    return answers as Answers<Q>;
  }

  async function probabilityOf(question: string, state: State, options: RequestOptions = {}): Promise<number> {
    const answers = await predict(state, { result: { type: "noul", instructions: question } }, options);
    return answers.result.noul;
  }

  async function jev(question: string, state: State, options: GateOptions = {}): Promise<boolean> {
    const threshold = options.threshold ?? 0.5;
    probability(threshold, "threshold");
    return await probabilityOf(question, state, options) >= threshold;
  }

  async function route<const C extends Criteria>(question: string, input: { criteria: C; state: State }, options: RequestOptions = {}): Promise<ChoiceKey<C>> {
    const answers = await predict(input.state, { result: { type: "choice", instructions: question, criteria: input.criteria } }, options);
    return answers.result.choice;
  }

  /** Normalize Vela's expected ordinal level to [0, 1]. Supply low-to-high labels. */
  async function score(question: string, input: { criteria: readonly string[]; state: State }, options: RequestOptions = {}): Promise<number> {
    const levels = input.criteria.length;
    const answers = await predict(input.state, { result: { type: "score", instructions: question, criteria: input.criteria } }, options);
    return answers.result.score / (levels - 1);
  }

  async function assert(question: string, state: State, options: GateOptions = {}): Promise<void> {
    const threshold = options.threshold ?? 0.5;
    probability(threshold, "threshold");
    const p = await probabilityOf(question, state, options);
    if (p < threshold) throw new JevAssertionError(question, p, threshold);
  }

  return Object.assign(jev, { predict, route, score, probability: probabilityOf, assert });
}
