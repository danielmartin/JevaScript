// JevaScript lowers before binding. The CLI and language service check the same
// ordinary TypeScript tree. No model runs during compilation or editor requests.
import {
    CallExpression, DiagnosticCategory, DiagnosticWithLocation, Expression, factory, isBindingElement,
    isCallExpression, isClassDeclaration, isFunctionDeclaration, isIdentifier, isImportClause,
    isImportSpecifier, isNamespaceImport, isNumericLiteral, isParameter, isPropertyAccessExpression,
    isVariableDeclaration, isExpression, Mutable, getTokenPosOfNode, idText, Node, NodeFlags, nullTransformationContext, setParentRecursive,
    setSourceMapRange, setTextRange, SourceFile, SyntaxKind, visitEachChild, visitNode, forEachChildRecursively,
} from "./_namespaces/ts.js";

function locate<T extends Node>(node: T, original: Node): T {
    setTextRange(node, original);
    setSourceMapRange(node, original);
    (node as Mutable<Node>).flags |= original.flags & NodeFlags.ContextFlags;
    return node;
}

export function decisionKind(node: Node): string | undefined {
    if (!isCallExpression(node)) return undefined;
    const callee = node.expression;
    if (isIdentifier(callee) && callee.escapedText === "decide") return "test";
    if (isPropertyAccessExpression(callee)) {
        if (isIdentifier(callee.expression) && callee.expression.escapedText === "decide") return idText(callee.name);
        if (["threshold", "and"].includes(idText(callee.name)) && decisionKind(callee.expression)) return idText(callee.name);
    }
    return undefined;
}

export function lowerJevaSourceFile(source: SourceFile): SourceFile {
    const errors: DiagnosticWithLocation[] = [];
    const diagnostic = (node: Node, message: string) => errors.push({ file: source,
        start: Math.max(0, getTokenPosOfNode(node, source)), length: Math.max(1, node.end - getTokenPosOfNode(node, source)),
        category: DiagnosticCategory.Error, code: 95001, messageText: message });
    const visit = (node: Node): Node => {
        if ((isVariableDeclaration(node) || isParameter(node) || isFunctionDeclaration(node) ||
            isClassDeclaration(node) || isImportClause(node) || isImportSpecifier(node) ||
            isNamespaceImport(node) || isBindingElement(node)) && node.name && isIdentifier(node.name) && node.name.escapedText === "decide") {
            diagnostic(node.name, "'decide' is a JevaScript intrinsic and cannot be redeclared.");
        }
        if (isCallExpression(node) && decisionKind(node)) return decision(node);
        return visitEachChild(node, visit, nullTransformationContext);
    };
    const expression = (node: Expression) => visitNode(node, visit, isExpression)!;
    const decision = (node: CallExpression, threshold?: Expression): Expression => {
        const kind = decisionKind(node);
        if ((kind === "threshold" || kind === "and") && isPropertyAccessExpression(node.expression) && isCallExpression(node.expression.expression)) {
            const previous = node.expression.expression;
            if (kind === "threshold") {
                if (node.arguments.length !== 1) diagnostic(node, "threshold expects exactly one probability.");
                const value = node.arguments[0];
                if (value && isNumericLiteral(value) && (Number(value.text) < 0 || Number(value.text) > 1)) diagnostic(value, "Threshold must be between 0 and 1.");
                return decision(previous, threshold ?? (value ? expression(value) : factory.createNumericLiteral(0.5)));
            }
            if (node.arguments.length !== 2) diagnostic(node, "and expects a question and state.");
            if (threshold && !isNumericLiteral(threshold)) diagnostic(threshold, "A threshold shared by an and chain must be a numeric literal. Apply dynamic thresholds to individual decisions instead.");
            let base = previous;
            while (["threshold", "and"].includes(decisionKind(base) ?? "") && isPropertyAccessExpression(base.expression) && isCallExpression(base.expression.expression)) base = base.expression.expression;
            if (decisionKind(base) !== "test") diagnostic(node, "and combines only boolean decisions.");
            const identifier = locate(factory.createIdentifier("decide"), node.expression.name);
            const right = locate(factory.createCallExpression(identifier, undefined, node.arguments), node);
            setTextRange(right, { pos: node.expression.name.pos, end: node.end });
            const operator = locate(factory.createToken(SyntaxKind.AmpersandAmpersandToken), node.expression.name);
            setTextRange(operator, { pos: node.expression.name.pos, end: node.expression.name.pos });
            return locate(factory.createBinaryExpression(decision(previous, threshold), operator,
                decision(right, threshold)), node);
        }
        if (!["test", "route", "score", "assert", "probability", "batch"].includes(kind ?? "")) diagnostic(node, `Unknown decision operation '${kind}'.`);
        if (threshold && kind !== "test" && kind !== "assert") diagnostic(node, "threshold applies only to boolean decisions and assertions.");
        const items = node.arguments.map(expression);
        if (threshold) {
            // A shared literal belongs to the outer chain in the source. Its
            // injected argument must not span later predicates in the editor tree.
            if (isNumericLiteral(threshold)) {
                threshold = setTextRange(factory.createNumericLiteral(threshold.text), { pos: node.arguments.end, end: node.arguments.end });
            }
            const key = locate(factory.createIdentifier("threshold"), threshold);
            setTextRange(key, { pos: threshold.pos, end: threshold.pos });
            const property = locate(factory.createPropertyAssignment(key, threshold), threshold);
            const properties = setTextRange(factory.createNodeArray([property]), threshold);
            items.push(locate(factory.createObjectLiteralExpression(properties), threshold));
        }
        const args = setTextRange(factory.createNodeArray(items), node.arguments);
        if (threshold) setTextRange(args, { pos: args.pos, end: Math.max(args.end, threshold.end) });
        const call = factory.updateCallExpression(node, node.expression, node.typeArguments, args);
        if (threshold) setTextRange(call, { pos: call.pos, end: Math.max(call.end, threshold.end) });
        const awaited = locate(factory.createAwaitExpression(call), node);
        if (threshold) setTextRange(awaited, { pos: node.pos, end: Math.max(node.end, call.end) });
        return awaited;
    };
    const result = visitEachChild(source, visit, nullTransformationContext);
    result.externalModuleIndicator = true;
    result.parseDiagnostics = [...source.parseDiagnostics, ...errors];
    // Lowering happens during parsing, so this is the tree the checker binds.
    // Factory updates mark nodes as synthesized; editor queries would then
    // follow their `original` links into the detached, unbound pre-lowering tree.
    (result as Mutable<Node>).flags &= ~NodeFlags.Synthesized;
    forEachChildRecursively(result, node => {
        (node as Mutable<Node>).flags &= ~NodeFlags.Synthesized;
    });
    setParentRecursive(result, true);
    return result;
}
