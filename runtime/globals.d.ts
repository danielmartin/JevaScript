import type { State, Criteria, ChoiceKey, GateOptions, RequestOptions, Question, Answers } from '../dist/client.js';
declare global {
  /** Ask a yes/no question. JevaScript waits automatically and branches on P(true). */
  function decide(question: string, state: State, options?: GateOptions): Promise<boolean>;
  namespace decide {
    /** Choose one of the declared labels. */
    function route<const C extends Criteria>(question: string, input: { criteria: C; state: State }, options?: RequestOptions): Promise<ChoiceKey<C>>;
    /** Score against an ordered low-to-high rubric, normalized to [0, 1]. */
    function score(question: string, input: { criteria: readonly string[]; state: State }, options?: RequestOptions): Promise<number>;
    /** Throw when the estimated probability is below the threshold. */
    function assert(question: string, state: State, options?: GateOptions): Promise<void>;
    /** Return the estimated probability of true without applying a threshold. */
    function probability(question: string, state: State, options?: RequestOptions): Promise<number>;
    /** Evaluate several questions about one state in one inference request. */
    function batch<const Q extends Record<string, Question>>(state: State, questions: Q, options?: RequestOptions): Promise<Answers<Q>>;
  }
}
export {};
