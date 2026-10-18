import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("proves every reachable pending acknowledgement leaves composerAwaitingAck false", () => {
  const source = readFileSync(join(__dirname, "../components/screens/AgentChatScreen.tsx"), "utf8");
  const tree = ts.createSourceFile(
    "AgentChatScreen.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const initializers: ts.VariableDeclaration[] = [];
  const setters: ts.CallExpression[] = [];
  let flag: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      if (
        ts.isArrayBindingPattern(node.name) &&
        node.name.elements.some((element) => element.getText(tree) === "pendingComposerAck")
      )
        initializers.push(node);
      if (node.name.getText(tree) === "composerAwaitingAck") flag = node.initializer;
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "setPendingComposerAck")
      setters.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  expect(initializers).toHaveLength(1);
  const initialization = initializers[0].initializer;
  expect(initialization && ts.isCallExpression(initialization)).toBe(true);
  expect((initialization as ts.CallExpression).arguments[0].kind).toBe(ts.SyntaxKind.NullKeyword);
  expect(setters.length).toBeGreaterThan(0);
  expect(flag).toBeDefined();
  const evaluate = new Function("pendingComposerAck", `return (${flag!.getText(tree)});`) as (
    pending: { timedOut: boolean } | null,
  ) => boolean;
  let nonNullStates = 0;
  function assertState(expression: ts.Expression) {
    if (ts.isConditionalExpression(expression)) {
      assertState(expression.whenTrue);
      assertState(expression.whenFalse);
    } else if (expression.kind === ts.SyntaxKind.NullKeyword) {
      expect(evaluate(null)).toBe(false);
    } else {
      expect(
        ts.isObjectLiteralExpression(expression),
        `unknown acknowledgement setter: ${expression.getText(tree)}`,
      ).toBe(true);
      const property = (expression as ts.ObjectLiteralExpression).properties.find(
        (property) => property.name?.getText(tree) === "timedOut",
      );
      expect(property && ts.isPropertyAssignment(property)).toBe(true);
      const value = (property as ts.PropertyAssignment).initializer;
      expect(value.kind, expression.getText(tree)).toBe(ts.SyntaxKind.TrueKeyword);
      expect(evaluate({ timedOut: value.kind === ts.SyntaxKind.TrueKeyword })).toBe(false);
      nonNullStates += 1;
    }
  }
  assertState((initialization as ts.CallExpression).arguments[0]);
  for (const setter of setters) {
    expect(setter.arguments).toHaveLength(1);
    assertState(setter.arguments[0]);
  }
  expect(nonNullStates).toBeGreaterThan(0);
});
