import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

export const normalizeGatewayRoute = (route: string) => route.split('?')[0].replace(/:[\w]+/g, ':param');

/** Extract concrete App requests, rejecting unknown init/method syntax rather than assuming GET.
 * tus owns its POST/HEAD/PATCH/DELETE protocol; its endpoint comes from the App's Upload options.
 */
export function appRoutes(sources?: readonly (string | { name: string; text: string })[]): Set<string> {
  const files = sources
    ? sources.map((source, index) => ts.createSourceFile(typeof source === 'string' ? `source-${index}.ts` : source.name, typeof source === 'string' ? source : source.text, ts.ScriptTarget.Latest, true))
    : [
      ...readdirSync(new URL('../src/gateway/', import.meta.url)).filter(name => name.endsWith('.ts')).map(name => new URL(`../src/gateway/${name}`, import.meta.url)),
      new URL('../src/lib/upload-drafts.ts', import.meta.url),
    ].map(path => ts.createSourceFile(String(path), readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true));
  const functions = new Map<string, ts.FunctionDeclaration | ts.MethodDeclaration>();
  function visit(node: ts.Node, callback: (node: ts.Node) => void) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
  for (const file of files) visit(file, node => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) functions.set(node.name.getText(file), node);
  });
  function unwrap(expression: ts.Expression): ts.Expression {
    return ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)
      ? unwrap(expression.expression) : expression;
  }
  function binds(name: ts.BindingName, target: string): boolean {
    return ts.isIdentifier(name) ? name.text === target
      : name.elements.some(element => !ts.isOmittedExpression(element) && binds(element.name, target));
  }
  function isReference(node: ts.Identifier): boolean {
    const parent = node.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return false;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) return false;
    return true;
  }
  function initializer(expression: ts.Identifier, requestOption = false): ts.Expression | undefined {
    const name = expression.text;
    let scope: ts.Node | undefined = expression.parent;
    while (scope) {
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        for (const statement of scope.statements) if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) if (binds(declaration.name, name)) {
            assert.ok(ts.isIdentifier(declaration.name), `无法静态识别解构绑定：${name}`);
            if (requestOption) {
              assert.ok(statement.declarationList.flags & ts.NodeFlags.Const, `无法静态识别可变绑定：${name}`);
              // One-use rule for init/method options, not mutation/alias tracking.
              // Path variables may also be used for cache keys; they are not options.
              let references = 0;
              visit(scope, node => {
                if (ts.isIdentifier(node) && node.text === name && isReference(node)) references++;
              });
              assert.equal(references, 1, `无法静态识别多次引用的请求绑定：${name}（声明外 ${references} 次；只接受单一使用）`);
            }
            return declaration.initializer;
          }
        }
      }
      // A parameter shadows outer bindings even when it has no initializer (or a default).
      if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => binds(parameter.name, name))) return undefined;
      scope = scope.parent;
    }
  }
  function values(raw: ts.Expression, seen = new Set<string>(), requestOption = false): string[] {
    const expression = unwrap(raw);
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isConditionalExpression(expression)) return [...values(expression.whenTrue, seen, requestOption), ...values(expression.whenFalse, seen, requestOption)];
    if (ts.isTemplateExpression(expression)) {
      let result = [expression.head.text];
      for (const span of expression.templateSpans) result = result.flatMap(prefix => {
        if (prefix.includes('?')) return [prefix];
        return values(span.expression, seen, requestOption).map(value => prefix + value + span.literal.text);
      });
      return result;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return values(expression.left, seen, requestOption).flatMap(left => values(expression.right, seen, requestOption).map(right => left + right));
    }
    if (ts.isIdentifier(expression)) {
      const value = initializer(expression, requestOption);
      if (value && !seen.has(expression.text)) return values(value, new Set([...seen, expression.text]), requestOption);
    }
    if (expression.getText().includes('baseUrl') && !ts.isTemplateExpression(expression) && !ts.isBinaryExpression(expression)) return [''];
    if (ts.isCallExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name.text : expression.expression.getText();
      const declaration = functions.get(name);
      if (declaration?.body && !seen.has(name)) {
        const results: string[] = [];
        const nextSeen = new Set([...seen, name]);
        visit(declaration.body, node => { if (ts.isReturnStatement(node) && node.expression) results.push(...values(node.expression, nextSeen, requestOption)); });
        if (results.length) return results;
      }
    }
    return [':param'];
  }
  function methods(expression: ts.Expression): string[] {
    const result = values(expression, new Set(), true).map(value => value.toUpperCase());
    assert.ok(result.every(value => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(value)), `无法静态识别请求方法：${expression.getText()}`);
    return result;
  }
  function initMethods(raw?: ts.Expression, seen = new Set<string>()): string[] | undefined {
    if (!raw) return undefined;
    const expression = unwrap(raw);
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      const value = initializer(expression, true);
      if (value) return initMethods(value, new Set([...seen, expression.text]));
    }
    assert.ok(ts.isObjectLiteralExpression(expression), `无法静态识别请求选项：${expression.getText()}`);
    let result: string[] | undefined;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        // Absent method must not overwrite an earlier property, including nested spreads.
        const spreadMethods = initMethods(property.expression, seen);
        if (spreadMethods) result = spreadMethods;
      } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'method') result = methods(property.name);
      else if (ts.isPropertyAssignment(property)) {
        const name = ts.isComputedPropertyName(property.name) ? values(property.name.expression, new Set(), true) : [ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : ':unknown'];
        assert.ok(!name.includes(':unknown') && !name.includes(':param'), `无法静态识别请求选项键：${property.getText()}`);
        if (name.includes('method')) result = methods(property.initializer);
      } else assert.fail(`无法静态识别请求选项：${property.getText()}`);
    }
    return result;
  }
  const routes = new Set<string>();
  const add = (method: string, expression: ts.Expression) => {
    for (const value of values(expression)) {
      assert.ok(value.startsWith('/'), `无法静态识别请求路径：${expression.getText()}`);
      routes.add(normalizeGatewayRoute(`${method} ${value}`));
    }
  };
  for (const file of files) visit(file, node => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(file);
      let path: ts.Expression | undefined;
      let requestMethods: string[] | undefined;
      if (name === 'request' && node.expression.getText(file) === 'this.request') {
        assert.ok(node.arguments[0], `请求缺少方法：${node.getText(file)}`);
        requestMethods = methods(node.arguments[0]); path = node.arguments[1];
      } else if (name === 'consumeResponse') {
        path = node.arguments[0]; requestMethods = initMethods(node.arguments[1]) ?? ['GET'];
      } else if (name === 'fetchImpl' || name === 'fetch') {
        path = node.arguments[0];
        // Skip transport delegates whose path is supplied by their caller, not concrete requests.
        if (path && values(path).every(value => !value.includes('/'))) path = undefined;
        if (path) requestMethods = initMethods(node.arguments[1]) ?? ['GET'];
      }
      if (path && requestMethods) for (const method of requestMethods) add(method, path);
    }
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'tus.Upload') {
      const options = node.arguments?.[1];
      assert.ok(options && ts.isObjectLiteralExpression(options), '无法静态识别 tus Upload 选项');
      const endpoint = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(file) === 'endpoint');
      assert.ok(endpoint && ts.isPropertyAssignment(endpoint), 'tus Upload 缺少 endpoint');
      for (const value of values(endpoint.initializer)) {
        assert.ok(value.startsWith('/'), '无法静态识别 tus endpoint');
        routes.add(normalizeGatewayRoute(`POST ${value}`));
        for (const method of ['HEAD', 'PATCH', 'DELETE']) routes.add(normalizeGatewayRoute(`${method} ${value}/:upload`));
      }
    }
    // Binary/native downloads and browser WebSocket paths are owned by API URL factories.
    if (ts.isMethodDeclaration(node) && /(?:Path|Url)$/.test(node.name.getText(file)) && node.body) visit(node.body, child => {
      if (ts.isReturnStatement(child) && child.expression) add('GET', child.expression);
    });
  });
  return routes;
}
