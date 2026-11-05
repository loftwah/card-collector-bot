import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

test("method branches that inspect path segments include a top-level exact-length guard", () => {
  const file = "src/server/api/router.ts";
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.equal(source.parseDiagnostics.length, 0, "router must parse before auditing");
  const failures = [];
  let checked = 0;
  const unparen = (node) => (ts.isParenthesizedExpression(node) ? unparen(node.expression) : node);
  const conjuncts = (node) => {
    node = unparen(node);
    return ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? [...conjuncts(node.left), ...conjuncts(node.right)]
      : [node];
  };
  function visit(node) {
    if (ts.isIfStatement(node)) {
      const expression = node.expression;
      const text = expression.getText(source);
      if (/segments\[\d+\]/.test(text) && /\bmethod\b/.test(text)) {
        checked++;
        const guard = conjuncts(expression).some(
          (part) =>
            ts.isBinaryExpression(part) &&
            part.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            part.left.getText(source) === "segments.length" &&
            ts.isNumericLiteral(part.right),
        );
        if (!guard)
          failures.push(
            `${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${text.replace(/\s+/g, " ")}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(checked > 100, `expected to inspect the dispatcher; saw ${checked} branches`);
  assert.deepEqual(failures, []);
});
