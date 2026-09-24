import path from "node:path";
import ts from "typescript";
import type { SymbolRecord } from "../types.js";

function languageFromPath(filePath: string): "javascript" | "typescript" {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".ts" || extension === ".tsx" ? "typescript" : "javascript";
}

function scriptKindFromPath(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.JS;
  }
}

/** Module id from `bitrix|local/modules/<module>/...` or the public copy `bitrix/js/<module>/...`. */
function moduleFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)(?:bitrix|local)\/modules\/([^/]+)\//i) ?? normalized.match(/(?:^|\/)bitrix\/js\/([^/]+)\//i);
  return match?.[1];
}

function heritageNames(sourceFile: ts.SourceFile, node: ts.ClassLikeDeclaration, token: ts.SyntaxKind): string[] {
  return (node.heritageClauses ?? [])
    .filter((clause) => clause.token === token)
    .flatMap((clause) => clause.types.map((type) => nodeText(sourceFile, type.expression)));
}

/** `BX.namespace('BX.Foo')` → `BX.Foo`. */
function bxNamespaceCall(node: ts.Expression | undefined): string | undefined {
  if (!node || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const callee = node.expression;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "BX" || callee.name.text !== "namespace") return undefined;
  const argument = node.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function isRootedAtThis(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
  return current.kind === ts.SyntaxKind.ThisKeyword;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function nodeText(sourceFile: ts.SourceFile, node: ts.Node): string {
  return node.getText(sourceFile).trim();
}

function declarationSignature(sourceFile: ts.SourceFile, node: ts.Node): string | undefined {
  const text = nodeText(sourceFile, node);
  const bodyIndex = text.indexOf("{");
  return (bodyIndex >= 0 ? text.slice(0, bodyIndex).trim() : text).replace(/\s+/g, " ");
}

function propertyNameText(sourceFile: ts.SourceFile, name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return nodeText(sourceFile, name.expression);
  return undefined;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function isFunctionLikeExpression(node: ts.Node): node is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function isObjectMethodInitializer(node: ts.Node): boolean {
  return isFunctionLikeExpression(node);
}

function isModuleExportsAccess(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "exports") return false;
  return ts.isIdentifier(expression.expression) && expression.expression.text === "module";
}

function exportsMemberName(expression: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (ts.isIdentifier(expression.expression) && expression.expression.text === "exports") return expression.name.text;
  if (isModuleExportsAccess(expression.expression)) return expression.name.text;
  return undefined;
}

function makeSymbol(sourceFile: ts.SourceFile, filePath: string, module: string | undefined, language: "javascript" | "typescript", node: ts.Node, symbol: Omit<SymbolRecord, "module" | "file" | "line" | "language">): SymbolRecord {
  return {
    ...symbol,
    module,
    file: filePath,
    line: lineOf(sourceFile, node),
    language
  };
}

function addExportSymbol(symbols: SymbolRecord[], sourceFile: ts.SourceFile, filePath: string, module: string | undefined, language: "javascript" | "typescript", node: ts.Node, name: string, signature?: string): void {
  symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
    type: "export",
    name,
    signature: signature ?? declarationSignature(sourceFile, node)
  }));
}

export function parseJsSymbols(source: string, filePath: string): SymbolRecord[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFromPath(filePath));
  const module = moduleFromPath(filePath);
  const language = languageFromPath(filePath);
  const symbols: SymbolRecord[] = [];
  const objectStack: string[] = [];
  const classStack: string[] = [];

  function addObjectMethod(node: ts.MethodDeclaration | ts.PropertyAssignment, objectName: string | undefined, methodName: string | undefined): void {
    if (!methodName) return;
    symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
      type: "object_method",
      name: objectName ? `${objectName}.${methodName}` : methodName,
      className: objectName,
      signature: declarationSignature(sourceFile, node)
    }));
  }

  const namespaceAliases = new Map<string, string>();

  function classHeritage(node: ts.ClassLikeDeclaration): Pick<SymbolRecord, "extends" | "implements"> {
    const extendsName = heritageNames(sourceFile, node, ts.SyntaxKind.ExtendsKeyword)[0];
    const implementsNames = heritageNames(sourceFile, node, ts.SyntaxKind.ImplementsKeyword);
    return {
      ...(extendsName ? { extends: extendsName } : {}),
      ...(implementsNames.length ? { implements: implementsNames } : {})
    };
  }

  /** Assignment target text with `BX.namespace()` aliases expanded (`ns.Foo` → `BX.Crm.Foo`). */
  function assignmentTargetName(left: ts.Expression): string {
    const text = nodeText(sourceFile, left).replace(/\s+/g, "");
    const [root, ...rest] = text.split(".");
    const alias = namespaceAliases.get(root);
    return alias && rest.length ? [alias, ...rest].join(".") : text;
  }

  /** Legacy `BX.Foo = function () {}`, `BX.Foo.prototype.bar = function () {}` and `BX.Foo = class {}` declarations. */
  function addAssignedDeclaration(node: ts.BinaryExpression): void {
    if (!ts.isPropertyAccessExpression(node.left) || isRootedAtThis(node.left)) return;
    const right = node.right;
    if (!isFunctionLikeExpression(right) && !ts.isClassExpression(right)) return;
    const name = assignmentTargetName(node.left);
    const prototypeMatch = name.match(/^(.+)\.prototype\.([^.]+)$/);
    if (prototypeMatch && !ts.isClassExpression(right)) {
      symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
        type: "method",
        name: prototypeMatch[2],
        className: prototypeMatch[1],
        signature: declarationSignature(sourceFile, node)
      }));
      return;
    }
    symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
      type: ts.isClassExpression(right) ? "class" : "function",
      name,
      ...(ts.isClassExpression(right) ? classHeritage(right) : {}),
      signature: declarationSignature(sourceFile, node)
    }));
  }

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
        type: "class",
        name: className,
        ...classHeritage(node),
        signature: declarationSignature(sourceFile, node)
      }));
      if (isExported(node)) addExportSymbol(symbols, sourceFile, filePath, module, language, node, className);

      classStack.push(className);
      ts.forEachChild(node, visit);
      classStack.pop();
      return;
    }

    if (ts.isMethodDeclaration(node) && classStack.length > 0) {
      const methodName = propertyNameText(sourceFile, node.name);
      if (methodName) {
        symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
          type: "method",
          name: methodName,
          className: classStack.at(-1),
          signature: declarationSignature(sourceFile, node)
        }));
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const functionName = node.name.text;
      symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
        type: "function",
        name: functionName,
        signature: declarationSignature(sourceFile, node)
      }));
      if (isExported(node)) addExportSymbol(symbols, sourceFile, filePath, module, language, node, functionName);
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const declaration of node.declarationList.declarations) {
        const variableName = propertyNameText(sourceFile, declaration.name);
        if (!variableName) continue;
        const namespaceName = bxNamespaceCall(declaration.initializer);
        if (namespaceName) namespaceAliases.set(variableName, namespaceName);
        if (declaration.initializer && isFunctionLikeExpression(declaration.initializer)) {
          symbols.push(makeSymbol(sourceFile, filePath, module, language, declaration, {
            type: "function",
            name: variableName,
            signature: declarationSignature(sourceFile, declaration)
          }));
        }
        if (exported) addExportSymbol(symbols, sourceFile, filePath, module, language, declaration, variableName, declarationSignature(sourceFile, declaration));
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const parent = node.parent;
      let objectName: string | undefined = objectStack.at(-1);
      if (ts.isVariableDeclaration(parent)) objectName = propertyNameText(sourceFile, parent.name);
      if (ts.isPropertyAssignment(parent)) objectName = propertyNameText(sourceFile, parent.name);
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) objectName = assignmentTargetName(parent.left);

      objectStack.push(objectName ?? "");
      for (const property of node.properties) {
        const name = propertyNameText(sourceFile, property.name);
        if (ts.isMethodDeclaration(property)) {
          addObjectMethod(property, objectName, name);
        } else if (ts.isPropertyAssignment(property) && isObjectMethodInitializer(property.initializer)) {
          addObjectMethod(property, objectName, name);
        }
        visit(property);
      }
      objectStack.pop();
      return;
    }

    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          addExportSymbol(symbols, sourceFile, filePath, module, language, element, element.name.text, nodeText(sourceFile, element));
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      addExportSymbol(symbols, sourceFile, filePath, module, language, node, node.isExportEquals ? "export=" : "default", nodeText(sourceFile, node));
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const exportedMember = exportsMemberName(node.left);
      if (exportedMember) {
        addExportSymbol(symbols, sourceFile, filePath, module, language, node, exportedMember, nodeText(sourceFile, node.left));
        if (isFunctionLikeExpression(node.right)) {
          symbols.push(makeSymbol(sourceFile, filePath, module, language, node, {
            type: "function",
            name: exportedMember,
            signature: declarationSignature(sourceFile, node)
          }));
        }
      } else if (isModuleExportsAccess(node.left)) {
        addExportSymbol(symbols, sourceFile, filePath, module, language, node, "module.exports", nodeText(sourceFile, node.left));
      } else {
        addAssignedDeclaration(node);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return symbols;
}
