#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const DESTRUCTIVE = new Set(["rm", "rmSync", "unlink", "unlinkSync", "rmdir", "rmdirSync", "rename", "renameSync"]);
const FS_MODULES = new Set(["node:fs", "node:fs/promises"]);

function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (name.endsWith(".ts")) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

function moduleSpecifierText(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

/**
 * W-733 / W-741: decide on the PARSED program, not on the file's text.
 *
 * A regex cannot tell code from data, and every attempt to patch it around one
 * failure opened another:
 *   - the original pattern read an import spelled inside a STRING (the synthetic
 *     attacker helper `dispatch_deadlock_w318.test.ts` writes to a temp dir,
 *     which must stay raw precisely because it acts as code outside the guard),
 *     and reported a violation no import swap could fix;
 *   - anchoring to the start of a line silenced that, but a static import is
 *     legal after another statement on the same line, so `const a = 1; import
 *     { rmSync } from "node:fs";` then evaded the lint — a blind spot the base
 *     regex did not have.
 *
 * The parser has neither problem: a string literal is never an ImportDeclaration
 * regardless of what it spells, and a declaration is found wherever it legally
 * sits. `typescript` is already a driver dependency (ci_test_inventory.ts parses
 * with it), so this costs no new dependency. Files that never mention `node:fs`
 * skip the parse.
 *
 * Covered shapes: named import, named re-export (`export { rmSync } from …`),
 * namespace import followed by a destructive member call, and the CommonJS
 * `require("node:fs")` destructure.
 */
export function lintRawDestructiveFs(root: string): string[] {
  const failures: string[] = [];
  const guard = resolve(root, "guard", "path_guard.ts");
  for (const file of files(root)) {
    if (resolve(file) === guard) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("node:fs")) continue;
    const rel = relative(root, file).replace(/\\/g, "/");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const namespaceAliases = new Set<string>();

    const bindingName = (element: ts.ImportSpecifier | ts.ExportSpecifier): string =>
      (element.propertyName ?? element.name).text;

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && FS_MODULES.has(moduleSpecifierText(node.moduleSpecifier) ?? "")) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = bindingName(element);
            if (DESTRUCTIVE.has(imported)) {
              failures.push(`${rel}: raw node:fs ${imported} import bypasses path_guard`);
            }
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          namespaceAliases.add(bindings.name.text);
        }
      }
      if (ts.isExportDeclaration(node) && FS_MODULES.has(moduleSpecifierText(node.moduleSpecifier) ?? "")) {
        const clause = node.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            const exported = bindingName(element);
            if (DESTRUCTIVE.has(exported)) {
              failures.push(`${rel}: raw node:fs ${exported} re-export bypasses path_guard`);
            }
          }
        }
      }
      // `const { rmSync } = require("node:fs")` / `= await import("node:fs")`.
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
        let call: ts.Node = node.initializer;
        if (ts.isAwaitExpression(call)) call = call.expression;
        if (
          ts.isCallExpression(call)
          && (call.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(call.expression) && call.expression.text === "require"))
          && FS_MODULES.has(moduleSpecifierText(call.arguments[0]) ?? "")
        ) {
          for (const element of node.name.elements) {
            const imported = ts.isIdentifier(element.propertyName ?? element.name)
              ? (element.propertyName ?? element.name).getText(source)
              : "";
            if (DESTRUCTIVE.has(imported)) {
              failures.push(`${rel}: raw node:fs ${imported} require/import() bypasses path_guard`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    if (namespaceAliases.size > 0) {
      const callVisit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && namespaceAliases.has(node.expression.expression.text)
          && DESTRUCTIVE.has(node.expression.name.text)
        ) {
          failures.push(`${rel}: namespace node:fs destructive call bypasses path_guard`);
        }
        ts.forEachChild(node, callVisit);
      };
      callVisit(source);
    }
  }
  return failures;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
  const failures = lintRawDestructiveFs(root);
  if (failures.length) {
    process.stderr.write(`path_guard lint: ${failures.length} violation(s)\n${failures.map((x) => `  ${x}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("path_guard lint: OK\n");
}
