/**
 * ESQL completion.
 *
 * Context-sensitive completion (ported from joaquinvulcano/esql-vscode, MIT —
 * see ATTRIBUTION.md) plus variables declared in the current document.
 *
 * Contexts:
 *   <root>.          -> parser domains (JSON, XMLNSC, MRM, ...)
 *   <root>.JSON.     -> Data
 *   <root>.XMLNSC.   -> (XML root element — schema-driven in Phase 3)
 *   <LE root>.       -> common LocalEnvironment fields
 *   Database.        -> (datasource placeholder)
 *   DECLARE name /   -> data types
 *   RETURNS          -> data types
 *   anything else    -> keywords + functions + tree vars + types +
 *                       declared vars + snippets, filtered by the word
 *                       currently being typed
 */

import { CompletionItem, CompletionItemKind } from 'vscode-languageserver';
import {
  ESQL_KEYWORDS,
  ESQL_TYPES,
  ESQL_MESSAGE_TREE_VARS,
  ESQL_DOMAINS,
  ESQL_LOCAL_ENVIRONMENT_FIELDS,
  ESQL_FUNCTIONS,
  EsqlDomainDoc,
} from './data/esqlData';
import { ESQL_SNIPPETS } from './data/snippets';
import { scan } from './scanner';
import { DECLARE_RE } from './diagnostics';
import type { DeclaredName } from './parser';

export type CompletionContextKind =
  | 'domains'
  | 'local-env'
  | 'json-data'
  | 'xmlns-root'
  | 'datasource'
  | 'types'
  | 'general';

/** Determine which completion context the cursor is in. */
export function detectCompletionContext(linePrefix: string): CompletionContextKind {
  // `<root>.JSON.` — dot after the domain already typed.
  if (/\b(InputRoot|OutputRoot)\.JSON\s*\.\s*$/i.test(linePrefix)) {
    return 'json-data';
  }
  // `<root>.XMLNSC.` — dot after the domain already typed.
  if (/\b(InputRoot|OutputRoot)\.XMLNSC\s*\.\s*$/i.test(linePrefix)) {
    return 'xmlns-root';
  }
  // `<root>.` or `<root>.<partial-domain>` — offer parser domains,
  // filtered by whatever has been typed so far.
  const domainPrefix = linePrefix.match(/\b(InputRoot|OutputRoot)\s*\.\s*([A-Za-z0-9_]*)$/i);
  if (domainPrefix) {
    const partial = domainPrefix[2].toLowerCase();
    if (
      partial === '' ||
      ESQL_DOMAINS.some((d) => d.name.toLowerCase().startsWith(partial))
    ) {
      return 'domains';
    }
  }

  if (/\b(InputLocalEnvironment|OutputLocalEnvironment|LocalEnvironment|Environment)\s*\.\s*$/i.test(linePrefix)) {
    return 'local-env';
  }
  if (/\bDatabase\s*\.\s*$/i.test(linePrefix)) {
    return 'datasource';
  }
  if (
    /\bRETURNS\s*$/i.test(linePrefix) ||
    /\bDECLARE\s+[A-Za-z_]\w*\s+(?:CONSTANT\s+)?\s*$/i.test(linePrefix)
  ) {
    return 'types';
  }
  return 'general';
}

function markdown(value: string): { kind: 'markdown'; value: string } {
  return { kind: 'markdown' as const, value };
}

function ci(label: string, kind: CompletionItemKind): CompletionItem {
  const item = CompletionItem.create(label);
  item.kind = kind;
  return item;
}

function domainItems(doc: EsqlDomainDoc[]): CompletionItem[] {
  return doc.map((d) => {
    const item = ci(d.name, CompletionItemKind.Module);
    item.detail = d.detail;
    item.documentation = markdown(d.description);
    return item;
  });
}

function typeItems(): CompletionItem[] {
  return ESQL_TYPES.map((t) => {
    const item = ci(t.name, CompletionItemKind.TypeParameter);
    item.detail = 'ESQL data type';
    item.documentation = markdown(t.description);
    return item;
  });
}

function functionItems(): CompletionItem[] {
  return ESQL_FUNCTIONS.map((fn) => {
    const item = ci(fn.name, CompletionItemKind.Function);
    item.detail = fn.signature;
    item.documentation = markdown(
      `**${fn.name}**\n\n${fn.description}` +
        (fn.returnType ? `\n\n**Returns:** \`${fn.returnType}\`` : '') +
        (fn.example ? `\n\n**Example:**\n\n\`\`\`esql\n${fn.example}\n\`\`\`` : '')
    );
    return item;
  });
}

function keywordItems(): CompletionItem[] {
  return ESQL_KEYWORDS.map((kw) => {
    const item = ci(kw, CompletionItemKind.Keyword);
    item.detail = 'ESQL keyword';
    return item;
  });
}

function treeVarItems(): CompletionItem[] {
  return ESQL_MESSAGE_TREE_VARS.map((v) => {
    const item = ci(v.name, CompletionItemKind.Variable);
    item.detail = 'ESQL message tree variable';
    item.documentation = markdown(v.description);
    return item;
  });
}

function snippetItems(): CompletionItem[] {
  return ESQL_SNIPPETS.map((s) => {
    const item = ci(s.label, CompletionItemKind.Snippet);
    item.detail = s.description;
    item.insertText = s.insertText;
    return item;
  });
}

/** Variables DECLAREd anywhere in the document (regex fallback path). */
function declaredVarItems(source: string): CompletionItem[] {
  const { lines } = scan(source);
  const seen = new Map<string, { name: string; detail: string }>();
  for (const line of lines) {
    // Shared regex with diagnostics.ts: every name of a multi-name
    // declaration is offered, with the declared type as detail.
    const m = line.match(DECLARE_RE);
    if (!m) continue;
    for (const rawName of m[1].split(',')) {
      const name = rawName.trim();
      const upper = name.toUpperCase();
      if (!seen.has(upper)) {
        const constant = /\bCONSTANT\b/i.test(line) ? 'CONSTANT ' : '';
        seen.set(upper, { name, detail: `${constant}${m[2].toUpperCase()}` });
      }
    }
  }
  return [...seen.values()].map(({ name, detail }) => {
    const item = ci(name, CompletionItemKind.Variable);
    item.detail = `Declared: ${detail}`;
    return item;
  });
}

function filterByPrefix(items: CompletionItem[], prefix: string): CompletionItem[] {
  if (!prefix) return items;
  const p = prefix.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().startsWith(p));
}

/** The word currently being typed (may be empty). */
export function wordBeingTyped(linePrefix: string): string {
  const m = linePrefix.match(/[A-Za-z_]\w*$/);
  return m ? m[0] : '';
}

/** Tree-based declared names/parameters -> completion items. */
function declaredItemsFromTree(declarations: DeclaredName[]): CompletionItem[] {
  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const d of declarations) {
    const upper = d.name.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const item = ci(d.name, CompletionItemKind.Variable);
    item.detail = `Declared: ${d.detail}`;
    items.push(item);
  }
  return items;
}

export function buildCompletionItems(
  context: CompletionContextKind,
  linePrefix: string,
  source: string,
  declarations?: DeclaredName[]
): CompletionItem[] {
  const prefix = wordBeingTyped(linePrefix);

  switch (context) {
    case 'json-data': {
      const item = ci('Data', CompletionItemKind.Property);
      item.detail = 'JSON payload container';
      item.documentation = markdown('Continue with `.Data.<field>` to address the JSON payload.');
      return [item];
    }
    case 'xmlns-root': {
      const item = ci('Root', CompletionItemKind.Property);
      item.detail = 'XML root element';
      item.documentation = markdown(
        'Replace with your XML root element name. ' +
          'Model-driven (XSD/MRM) completion is planned for a later phase.'
      );
      return [item];
    }
    case 'domains':
      return filterByPrefix(domainItems(ESQL_DOMAINS), prefix);
    case 'local-env':
      return filterByPrefix(domainItems(ESQL_LOCAL_ENVIRONMENT_FIELDS), prefix);
    case 'datasource': {
      const item = ci('DS_YOUR_DATASOURCE', CompletionItemKind.Reference);
      item.detail = 'Database datasource';
      item.documentation = markdown(
        'Replace with the datasource name configured in the Integration Server, ' +
          'e.g. `DS_ORACLE_PROD`.'
      );
      return [item];
    }
    case 'types': {
      const items = typeItems();
      if (/\bDECLARE\s+[A-Za-z_]\w*\s+$/i.test(linePrefix)) {
        const c = ci('CONSTANT', CompletionItemKind.TypeParameter);
        c.detail = 'Declares the variable as a constant (use before the type)';
        items.unshift(c);
      }
      return filterByPrefix(items, prefix);
    }
    case 'general': {
      const items = [
        ...functionItems(),
        ...keywordItems(),
        ...treeVarItems(),
        ...typeItems(),
        ...(declarations ? declaredItemsFromTree(declarations) : declaredVarItems(source)),
        ...snippetItems(),
      ];
      return filterByPrefix(items, prefix);
    }
  }
}
