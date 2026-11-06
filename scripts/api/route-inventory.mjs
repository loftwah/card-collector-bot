#!/usr/bin/env node
/**
 * Build the authoritative HTTP route inventory from the code that dispatches
 * requests. This is deliberately a static reading of routeApi: it records the
 * method, exact path shape, guards, agent scopes, request schema summary and
 * domain calls for each reachable branch. It also checks that no earlier
 * branch accepts a later branch's example path.
 *
 * The inventory is not a substitute for the HTTP tests. It is the map those
 * tests and the browser, CLI, MCP and OpenAPI consumers are checked against.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const ROUTER = path.join(ROOT, "src/server/api/router.ts");
const OPENAPI = path.join(ROOT, "public/openapi.json");
const OUTPUT_JSON = path.join(ROOT, "docs/api-route-inventory.json");
const OUTPUT_MD = path.join(ROOT, "docs/API_ROUTE_INVENTORY.md");

const GUARD_NAMES = new Set([
  "ensureOwner",
  "ensureOps",
  "ensureMemberAdmin",
  "ensureStepUp",
  "ensureContentRead",
  "ensureContentWrite",
  "ensureEconomyRead",
  "ensureEconomyWrite",
  "ensureCollectionsRead",
  "ensureCollectionsWrite",
  "ensureStudioCatalogueRead",
  "ensureStudioCatalogueWrite",
  "ensureGlobalCollectionManager",
  "requireUser",
  "requireScope",
  "requireRole",
  "requireSuperAdmin",
  "requireRecentStrongAuth",
  "requireGlobalCollectionManager",
  "requireGlobalCollectionRead",
  "requireGlobalCollectionWrite",
  "requireNpcRead",
  "requireNpcManager",
  "playerWrite",
]);

const AUTH_ONLY = new Set(["requireUser", "playerWrite", "assertCsrf"]);
const WRITE_PREFIX =
  /^(accept|adjust|adopt|archive|assign|backfill|bulk|cancel|claim|commit|complete|create|decline|delete|execute|expire|fail|join|link|merge|process|publish|record|recycleCommit|replace|retire|revoke|review|send|set|submit|toggle|update|upload)/;

function unparen(node) {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function conjuncts(node) {
  node = unparen(node);
  if (
    node &&
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...conjuncts(node.left), ...conjuncts(node.right)];
  }
  return node ? [node] : [];
}

function stringValue(node) {
  node = unparen(node);
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function numericValue(node) {
  node = unparen(node);
  if (node && ts.isNumericLiteral(node)) return Number(node.text);
  return null;
}

function segmentsIndex(node) {
  // segments[2] or (segments[2] ?? "")
  node = unparen(node);
  if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    node = unparen(node.left);
  }
  if (
    node &&
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "segments"
  ) {
    const index = numericValue(node.argumentExpression);
    if (index !== null) return index;
  }
  return null;
}

function parseCondition(expression, source) {
  const out = {
    methods: [],
    lengths: [],
    literals: new Map(),
    alternatives: new Map(),
    params: new Set(),
    allowed: new Map(),
    isStudio: false,
  };
  for (const part of conjuncts(expression)) {
    const node = unparen(part);
    if (!node) continue;
    if (ts.isIdentifier(node) && node.text === "isStudio") out.isStudio = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const left = parseCondition(node.left, source);
      const right = parseCondition(node.right, source);
      out.methods.push(...left.methods, ...right.methods);
      out.lengths.push(...left.lengths, ...right.lengths);
      for (const [key, value] of left.literals) out.literals.set(key, value);
      for (const [key, value] of right.literals) out.literals.set(key, value);
      for (const [key, values] of [...left.alternatives, ...right.alternatives]) {
        const current = out.alternatives.get(key) ?? new Set();
        for (const value of values) current.add(value);
        out.alternatives.set(key, current);
      }
      for (const value of left.params) out.params.add(value);
      for (const value of right.params) out.params.add(value);
      for (const [key, value] of [...left.allowed, ...right.allowed]) out.allowed.set(key, value);
      out.isStudio ||= left.isStudio || right.isStudio;
      continue;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        if (node.left.getText(source) === "method") {
          const value = stringValue(node.right);
          if (value) out.methods.push(value);
        }
        if (node.left.getText(source) === "segments.length") {
          const value = numericValue(node.right);
          if (value !== null) out.lengths.push(value);
        }
        const index = segmentsIndex(node.left);
        if (index !== null) {
          const value = stringValue(node.right);
          if (value !== null) {
            out.literals.set(index, value);
            const set = out.alternatives.get(index) ?? new Set();
            set.add(value);
            out.alternatives.set(index, set);
          }
        }
        const reverse = segmentsIndex(node.right);
        if (reverse !== null) {
          const value = stringValue(node.left);
          if (value !== null) {
            out.literals.set(reverse, value);
            const set = out.alternatives.get(reverse) ?? new Set();
            set.add(value);
            out.alternatives.set(reverse, set);
          }
        }
      }
      if (op === ts.SyntaxKind.GreaterThanEqualsToken && node.left.getText(source) === "segments.length") {
        const value = numericValue(node.right);
        if (value !== null) out.lengths.push({ atLeast: value });
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const nested = parseCondition(node, source);
        out.methods.push(...nested.methods);
        out.lengths.push(...nested.lengths);
        for (const [key, value] of nested.literals) out.literals.set(key, value);
        for (const [key, values] of nested.alternatives) {
          const current = out.alternatives.get(key) ?? new Set();
          for (const value of values) current.add(value);
          out.alternatives.set(key, current);
        }
        for (const value of nested.params) out.params.add(value);
        for (const [key, value] of nested.allowed) out.allowed.set(key, value);
        out.isStudio ||= nested.isStudio;
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "includes" &&
        node.arguments.length === 1
      ) {
        const index = segmentsIndex(node.arguments[0]);
        if (index !== null) {
          const values = [];
          const array = unparen(callee.expression);
          if (ts.isArrayLiteralExpression(array)) {
            for (const element of array.elements) {
              const value = stringValue(element);
              if (value !== null) values.push(value);
            }
          }
          if (values.length) out.allowed.set(index, values);
        }
      }
    }
    const index = segmentsIndex(node);
    if (index !== null) out.params.add(index);
  }
  return out;
}

function mergeConditions(parent, child) {
  const out = {
    methods: [...parent.methods, ...child.methods],
    lengths: [...parent.lengths, ...child.lengths],
    literals: new Map(parent.literals),
    alternatives: new Map(parent.alternatives),
    params: new Set(parent.params),
    allowed: new Map(parent.allowed),
    isStudio: parent.isStudio || child.isStudio,
  };
  for (const [key, value] of child.literals) out.literals.set(key, value);
  for (const [key, values] of child.alternatives) {
    const current = out.alternatives.get(key) ?? new Set();
    for (const value of values) current.add(value);
    out.alternatives.set(key, current);
  }
  for (const value of child.params) out.params.add(value);
  for (const [key, value] of child.allowed) out.allowed.set(key, value);
  return out;
}

function exactLength(conditions) {
  const exact = conditions.lengths.filter((value) => typeof value === "number");
  if (!exact.length) return null;
  return Math.max(...exact);
}

function routeTemplates(conditions) {
  const length = exactLength(conditions);
  if (length === null) return [];
  const options = [];
  for (let index = 0; index < length; index++) {
    const alternatives = conditions.alternatives.get(index);
    const allowed = conditions.allowed.get(index);
    const literal = conditions.literals.get(index);
    if (alternatives?.size) options.push([...alternatives]);
    else if (allowed?.length) options.push([...allowed]);
    else if (literal !== undefined) options.push([literal]);
    else if (index === 0 && conditions.isStudio) options.push(["admin"]);
    else options.push([":param"]);
  }
  let templates = [[]];
  for (const choices of options) {
    templates = templates.flatMap((prefix) => choices.map((choice) => [...prefix, choice]));
  }
  return templates.map((parts) => `/api/v1/${parts.join("/")}`);
}

function functionName(node) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function collectCalls(node, source, calls = []) {
  if (ts.isCallExpression(node)) {
    const name = functionName(node);
    if (name) {
      calls.push({
        name,
        text: node.getText(source).replace(/\s+/g, " ").slice(0, 220),
        args: node.arguments.map((argument) => argument.getText(source).replace(/\s+/g, " ")),
      });
    }
  }
  ts.forEachChild(node, (child) => {
    collectCalls(child, source, calls);
  });
  return calls;
}

function schemaSummary(schemaNode, source) {
  if (!schemaNode) return null;
  let node = unparen(schemaNode);
  let optional = false;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "optional"
  ) {
    optional = true;
    node = unparen(node.expression.expression);
  }
  if (ts.isIdentifier(node)) return `${node.text}${optional ? " (optional)" : ""}`;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "object" &&
    node.arguments.length === 1 &&
    ts.isObjectLiteralExpression(node.arguments[0])
  ) {
    const fields = [];
    for (const property of node.arguments[0].properties) {
      if (!ts.isPropertyAssignment(property)) {
        fields.push("...");
        continue;
      }
      const name = property.name.getText(source).replace(/^["']|["']$/g, "");
      const text = property.initializer.getText(source).replace(/\s+/g, " ");
      const isOptional = /\.optional\(\)/.test(text);
      const type = text.match(/z\.([a-zA-Z]+)/)?.[1] ?? (text.match(/^[A-Za-z_$][\w$]*/) ?? ["schema"])[0];
      fields.push(`${name}${isOptional ? "?" : ""}:${type}`);
    }
    return `{ ${fields.join(", ")} }${optional ? " (optional)" : ""}`;
  }
  return `${node.getText(source).replace(/\s+/g, " ").slice(0, 180)}${optional ? " (optional)" : ""}`;
}

function blockTerminates(node) {
  if (!node) return false;
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBlock(node)) return node.statements.some(blockTerminates);
  return false;
}

function extractRoutes() {
  const sourceText = fs.readFileSync(ROUTER, "utf8");
  const source = ts.createSourceFile(ROUTER, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) {
    throw new Error(`router did not parse: ${source.parseDiagnostics.length} diagnostics`);
  }

  const routes = [];
  function walk(statement, inherited, ancestorGuards) {
    if (ts.isIfStatement(statement)) {
      const text = statement.expression.getText(source);
      const relevant = /segments\[|segments\.length|\bmethod\b/.test(text);
      if (relevant) {
        const conditions = mergeConditions(inherited, parseCondition(statement.expression, source));
        const guards = [...ancestorGuards];
        const calls = collectCalls(statement.thenStatement, source);
        for (const call of calls) {
          if (GUARD_NAMES.has(call.name) && !guards.includes(call.name)) guards.push(call.name);
        }
        const methods = [...new Set(conditions.methods)];
        const templates = routeTemplates(conditions);
        if (methods.length && templates.length) {
          const schema = calls.find((call) => call.name === "readJson");
          const schemaNode = schema ? findReadJsonSchema(statement.thenStatement, source) : null;
          for (const template of templates) {
            routes.push({
              method: methods.join(","),
              path: template,
              line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
              guards: guards.filter((name) => !AUTH_ONLY.has(name)),
              auth_only: guards.filter((name) => AUTH_ONLY.has(name)),
              scopes: calls
                .filter((call) => call.name === "requireScope")
                .flatMap((call) => call.args)
                .filter((arg) => !arg.startsWith("ctx"))
                .map((arg) => arg.replace(/["']/g, "")),
              roles: calls
                .filter((call) => call.name === "requireRole")
                .flatMap((call) => call.args)
                .filter((arg) => !arg.startsWith("ctx"))
                .map((arg) => arg.replace(/["']/g, "")),
              schema: schemaSummary(schemaNode, source),
              calls: [...new Set(calls.map((call) => call.name))].filter(
                (name) =>
                  !GUARD_NAMES.has(name) &&
                  ![
                    "json",
                    "readJson",
                    "requireScope",
                    "requireRole",
                    "newId",
                    "nowIso",
                    "first",
                    "all",
                    "idempotencyInput",
                    "assertCsrf",
                    "Number",
                    "String",
                    "Boolean",
                    "Math",
                    "parseInt",
                    "parseFloat",
                    "object",
                    "array",
                    "enum",
                    "union",
                    "literal",
                    "record",
                    "string",
                    "number",
                    "boolean",
                  ].includes(name),
              ),
              studio_alias: conditions.isStudio,
              source_condition: text.replace(/\s+/g, " ").slice(0, 400),
            });
          }
        }
        // Continue into nested route branches (for example per-method handlers
        // inside one segment shape).
        for (const nested of nestedStatements(statement.thenStatement)) {
          walk(nested, conditions, guards);
        }
      }
    }
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "routeApi") {
      for (const child of statement.body.statements) walk(child, emptyConditions(), []);
    }
  }
  return { routes, sourceText, source };
}

function emptyConditions() {
  return {
    methods: [],
    lengths: [],
    literals: new Map(),
    alternatives: new Map(),
    params: new Set(),
    allowed: new Map(),
    isStudio: false,
  };
}

function nestedStatements(node) {
  if (ts.isBlock(node)) return node.statements;
  return [node];
}

function findReadJsonSchema(node, source) {
  let found = null;
  function visit(current) {
    if (found) return;
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "readJson" &&
      current.arguments.length >= 2
    ) {
      found = current.arguments[1];
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function templateToRegex(template) {
  const escaped = template
    .split("/")
    .map((segment) =>
      segment === ":param" ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${escaped}/?$`);
}

function examplePath(template) {
  return template
    .split("/")
    .map((segment) => (segment === ":param" ? "sample" : segment))
    .join("/");
}

function shadowedRoutes(routes) {
  const findings = [];
  for (let later = 0; later < routes.length; later++) {
    const route = routes[later];
    const example = examplePath(route.path);
    for (const method of route.method.split(",")) {
      for (let earlier = 0; earlier < later; earlier++) {
        const candidate = routes[earlier];
        if (!candidate.method.split(",").includes(method)) continue;
        if (candidate.path === route.path) {
          findings.push(`${route.method} ${route.path} is a duplicate of line ${candidate.line}`);
          break;
        }
        if (templateToRegex(candidate.path).test(example)) {
          findings.push(
            `${route.method} ${route.path} (line ${route.line}) is reached through earlier ${candidate.path} (line ${candidate.line})`,
          );
          break;
        }
      }
    }
  }
  return [...new Set(findings)];
}

function directAstroRoutes() {
  const pages = path.join(ROOT, "src/pages");
  const routes = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry.name)) {
        const relative = path.relative(pages, full).replace(/\\/g, "/");
        if (!relative.startsWith("api/")) continue;
        // The dispatcher catch-all is represented by the extracted routeApi
        // branches, not as one route that would accept every path.
        if (relative === "api/v1/[...path].ts") continue;
        const text = fs.readFileSync(full, "utf8");
        const methods = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|ALL)\b/g)].map((match) => match[1]);
        if (!methods.length) continue;
        const rest = relative
          .replace(/\.(ts|js)$/, "")
          .replace(/\[([^\]]+)\]/g, ":param");
        const wildcard = /\[\s*\.\.\./.test(relative);
        const template = "/" + rest.replace(/\/:param$/, "").replace(/:param$/, "");
        for (const method of methods) {
          routes.push({
            method: method === "ALL" ? "ALL" : method,
            path: template,
            line: null,
            guards: ["astro-route"],
            auth_only: [],
            scopes: [],
            roles: [],
            schema: null,
            calls: [],
            wildcard,
            source_condition: wildcard ? "direct Astro catch-all route" : "direct Astro route",
          });
        }
      }
    }
  }
  walk(pages);
  return routes;
}

function consumerPaths() {
  const files = [];
  for (const directory of ["src/components", "src/pages", "src/layouts", "scripts", "mcp"]) {
    const full = path.join(ROOT, directory);
    if (!fs.existsSync(full)) continue;
    const stack = [full];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          stack.push(child);
        } else if (/\.(ts|tsx|js|mjs|astro)$/.test(entry.name)) {
          files.push(child);
        }
      }
    }
  }
  const found = [];
  const seen = new Set();
  for (const file of files) {
    if (file.endsWith(path.join("api", "route-inventory.mjs"))) continue;
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("/api/")) continue;
    for (const call of extractApiCalls(text, file.endsWith(".astro"))) {
      const normalized = call.path;
      if (!normalized.startsWith("/api/")) continue;
      const key = `${path.relative(ROOT, file)}:${call.method ?? "*"}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        file: path.relative(ROOT, file),
        path: normalized,
        method: call.method ?? undefined,
      });
    }
  }
  return found;
}

function normalizeConsumerPath(value) {
  const pathOnly = value.split("?")[0].split("#")[0];
  return pathOnly
    .split("/")
    .map((segment) => (segment.includes(":param") && segment !== ":param" ? ":param" : segment))
    .join("/");
}

function pathFromNode(node, source) {
  node = unparen(node);
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.startsWith("/api/") && !/\s/.test(node.text) ? node.text : null;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = span.expression.getText(source);
      const inQuery = value.includes("?");
      // A conditional that appends `?query=...` is not a path segment. A
      // dynamic value inside a segment (`album-pool-${stamp}`) collapses to
      // one wildcard segment.
      if (!inQuery && !expression.includes("?")) value += ":param";
      value += span.literal.text;
    }
    return value.startsWith("/api/") && !/\s/.test(value) ? value : null;
  }
  return null;
}

function explicitMethod(node) {
  node = unparen(node);
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (property.name.getText() !== "method") continue;
    const value = stringValue(property.initializer);
    if (value) return value.toUpperCase();
  }
  return null;
}

function extractApiCalls(text, isAstro) {
  const out = [];
  if (isAstro) {
    for (const match of text.matchAll(/fetch\(\s*["'`](\/api\/[^"'`\s]*)["'`]([\s\S]{0,400}?)\)/g)) {
      const method = match[2].match(/method:\s*["']([A-Z]+)["']/)?.[1] ?? null;
      out.push({
        path: normalizeConsumerPath(match[1].replace(/\$\{[^}]+\}/g, ":param")),
        method,
      });
    }
    return out;
  }
  const source = ts.createSourceFile("consumer.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = functionName(node);
      if (["api", "apiJson", "fetch"].includes(name)) {
        const path = pathFromNode(node.arguments[0], source);
        if (path) {
          out.push({
            path: normalizeConsumerPath(path),
            method: explicitMethod(node.arguments[1]),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

function openApiPaths() {
  const spec = JSON.parse(fs.readFileSync(OPENAPI, "utf8"));
  return Object.entries(spec.paths).flatMap(([route, operations]) =>
    Object.keys(operations)
      .filter((method) => ["get", "post", "put", "patch", "delete", "head"].includes(method))
      .map((method) => ({
        method: method.toUpperCase(),
        path: route.replace(/\{[^}]+\}/g, ":param"),
      })),
  );
}

function routeExample(route) {
  return route.path
    .split("/")
    .map((segment) => (segment === ":param" ? "sample" : segment))
    .join("/");
}

function consumerRegex(template) {
  const pattern = template
    .split("/")
    .map((segment) => (segment === ":param" ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}/?$`);
}

function studioAlias(template) {
  return template.replace(/^\/api\/v1\/studio\//, "/api/v1/admin/");
}

function exampleOf(template) {
  return template
    .split("/")
    .map((segment) => (segment === ":param" ? "sample" : segment))
    .join("/");
}

function consumerMatches(routes, template, method) {
  return routes.filter((route) => {
    if (method && route.method !== "ALL" && !route.method.split(",").includes(method)) return false;
    if (route.wildcard)
      return template === route.path || template.startsWith(`${route.path}/`);
    // Intersection, not one-way containment: a literal consumer path can
    // target a parameterised route, and a parameterised consumer path can
    // target one of several literal route variants.
    return (
      consumerRegex(route.path).test(exampleOf(template)) ||
      consumerRegex(template).test(routeExample(route))
    );
  });
}

function resolveConsumer(routes, consumer) {
  const candidates = [consumer.path, studioAlias(consumer.path)];
  for (const candidate of candidates) {
    const matches = consumerMatches(routes, candidate, consumer.method);
    if (matches.length) return { ...consumer, matches: matches.map((route) => `${route.method} ${route.path}`) };
  }
  return { ...consumer, matches: [] };
}

function build() {
  const { routes, sourceText } = extractRoutes();
  const direct = directAstroRoutes();
  const combined = [...routes, ...direct];
  const shadowed = shadowedRoutes(routes);
  const consumers = consumerPaths().map((consumer) => resolveConsumer(combined, consumer));
  const openapi = openApiPaths().map((operation) => resolveConsumer(combined, operation));
  return {
    schema_version: 1,
    source: "src/server/api/router.ts",
    route_count: routes.length,
    direct_route_count: direct.length,
    routes,
    direct,
    shadowed,
    unresolved_consumers: consumers.filter((consumer) => !consumer.matches.length),
    unresolved_openapi: openapi.filter((operation) => !operation.matches.length),
    consumers,
    openapi,
    source_text: sourceText,
  };
}

function normalizedInventory(inventory) {
  return {
    route_count: inventory.route_count,
    direct_route_count: inventory.direct_route_count,
    routes: inventory.routes.map((route) => ({
      method: route.method,
      path: route.path,
      guards: route.guards,
      auth_only: route.auth_only,
      scopes: route.scopes,
      roles: route.roles,
      schema: route.schema,
      calls: route.calls,
      studio_alias: route.studio_alias,
    })),
    direct: inventory.direct.map((route) => ({ method: route.method, path: route.path })),
  };
}

function renderMarkdown(inventory) {
  const lines = [];
  lines.push("# HTTP API route inventory", "");
  lines.push(
    "Generated from `src/server/api/router.ts` and the direct Astro routes under `src/pages/api`. Regenerate with `pnpm api:inventory`. The inventory records the first matching branch, not a second copy of the route table.",
    "",
  );
  lines.push(`- Dispatcher routes: **${inventory.route_count}**`);
  lines.push(`- Direct Astro routes: **${inventory.direct_route_count}**`);
  lines.push(`- Shadowed or duplicate branches: **${inventory.shadowed.length}**`);
  lines.push(`- Consumer paths without a route: **${inventory.unresolved_consumers.length}**`);
  lines.push(`- OpenAPI operations without a route: **${inventory.unresolved_openapi.length}**`);
  lines.push("");
  lines.push(
    "`/api/v1/studio/*` is dispatched as `/api/v1/admin/*` after a live Studio role check; studio-alias branches are listed under the administrator path they execute.",
    "",
  );
  lines.push("## Dispatcher routes", "");
  lines.push("| # | Method | Path | Guards | Agent scopes | Request schema | Side effects | Line |");
  lines.push("|---:|---|---|---|---|---|---|---:|");
  inventory.routes.forEach((route, index) => {
    const writes = route.calls.filter((name) => WRITE_PREFIX.test(name));
    const reads = route.calls.filter((name) => !writes.includes(name)).slice(0, 5);
    const effects = [
      writes.length ? `writes: ${writes.join(", ")}` : "",
      reads.length ? `reads: ${reads.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(
      `| ${index + 1} | ${route.method} | \`${route.path}\` | ${route.guards.join(", ") || "—"} | ${
        route.scopes.join(", ") || "—"
      } | ${route.schema ? `\`${route.schema.replaceAll("|", "\\|")}\`` : "—"} | ${
        effects || "—"
      } | ${route.line} |`,
    );
  });
  lines.push("", "## Direct Astro routes", "", "| Method | Path |", "|---|---|");
  for (const route of inventory.direct) lines.push(`| ${route.method} | \`${route.path}\` |`);
  lines.push("", "## Precedence check", "");
  if (inventory.shadowed.length) {
    for (const finding of inventory.shadowed) lines.push(`- **FAIL** ${finding}`);
  } else {
    lines.push("No earlier dispatcher branch accepts a later branch's example path.");
  }
  lines.push("", "## Consumer reconciliation", "");
  if (inventory.unresolved_consumers.length) {
    for (const consumer of inventory.unresolved_consumers) {
      lines.push(`- **UNRESOLVED** \`${consumer.path}\` in \`${consumer.file}\``);
    }
  } else {
    lines.push(
      `All ${inventory.consumers.length} browser, CLI and MCP paths resolve to a dispatcher or direct Astro route.`,
    );
  }
  lines.push("", "## OpenAPI reconciliation", "");
  if (inventory.unresolved_openapi.length) {
    for (const operation of inventory.unresolved_openapi) {
      lines.push(`- **UNRESOLVED** ${operation.method} \`${operation.path}\``);
    }
  } else {
    lines.push(
      `All ${inventory.openapi.length} documented operations resolve to a dispatcher or direct Astro route.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

const inventory = build();
const write = process.argv.includes("--write");
if (write) {
  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(normalizedInventory(inventory), null, 2)}\n`);
  fs.writeFileSync(OUTPUT_MD, renderMarkdown(inventory));
  console.log(
    `Wrote ${path.relative(ROOT, OUTPUT_JSON)} (${inventory.route_count} routes) and ${path.relative(ROOT, OUTPUT_MD)}.`,
  );
} else {
  console.log(
    `${inventory.route_count} dispatcher routes, ${inventory.direct_route_count} direct Astro routes, ${inventory.shadowed.length} shadowed, ${inventory.unresolved_consumers.length} unresolved consumers, ${inventory.unresolved_openapi.length} unresolved OpenAPI operations.`,
  );
}
if (inventory.shadowed.length) {
  for (const finding of inventory.shadowed) console.error(`Shadow: ${finding}`);
  process.exitCode = 1;
}

export { build, extractRoutes, normalizedInventory, renderMarkdown, templateToRegex, consumerMatches };
