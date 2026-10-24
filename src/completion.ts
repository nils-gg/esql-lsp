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
 *                       declared vars in scope + snippets, one item per
 *                       label, filtered by the word currently being typed
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
import { declarationsFromSource, visibleDeclarationsAt } from './definitions';
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

/**
 * Declared names → completion items, from either source of declarations: the
 * parse tree, or the shared regex extractor (`declarationsFromSource`). Both
 * modes come through here, so they offer the same shape — including multi-name
 * DECLAREs, parameters of a multi-line routine header, and quoted `EXTERNAL`
 * names.
 */
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

/**
 * One item per label. The lists the `general` context concatenates overlap: the
 * same word is a keyword *and* a data type (`INTEGER`), a keyword *and* a
 * function (`EXISTS`), and a declared variable can shadow a built-in (`FLOOR`
 * in a file that declares `DECLARE floor CHARACTER`). A client shows each of
 * those as its own row with identical text, which is pure noise
 * (ISSUES.md I-17). Merging keeps the form that says the most about what will be
 * inserted.
 *
 * Matching is on the exact label, *not* case-folded: `IF` (keyword, inserts
 * `IF`) and `if` (snippet, expands a block) are two different completions that
 * merely look alike at a glance, and folding them made one of them vanish. They
 * stay.
 */
const KIND_PREFERENCE: ReadonlyMap<CompletionItemKind, number> = new Map([
  [CompletionItemKind.Variable, 0], // declared names and message tree variables
  [CompletionItemKind.Snippet, 2], // snippets expand into real text
  [CompletionItemKind.Function, 3],
  [CompletionItemKind.TypeParameter, 4], // the data types are TypeParameter kind
  [CompletionItemKind.Keyword, 5], // "ESQL keyword" says the least
]);

function dedupeByLabel(
  items: CompletionItem[],
  preferred: ReadonlySet<CompletionItem> = new Set()
): CompletionItem[] {
  const rankOf = (item: CompletionItem): number =>
    preferred.has(item)
      ? -1 // this document's own declared names beat any built-in of the same kind
      : KIND_PREFERENCE.get(item.kind ?? CompletionItemKind.Keyword) ?? 9;
  const best = new Map<string, CompletionItem>();
  for (const item of items) {
    const held = best.get(item.label);
    if (!held) {
      best.set(item.label, item);
      continue;
    }
    if (rankOf(item) < rankOf(held)) best.set(item.label, item);
  }
  const kept = new Set(best.values());
  const out: CompletionItem[] = [];
  for (const item of items) {
    if (!kept.has(item)) continue;
    kept.delete(item); // keep exactly one, at its first position
    out.push(item);
  }
  return out;
}

/**
 * Declared names a position may actually use. Every entry carries the `scope`
 * the parser computed for it (routine body / module / file), and offering the
 * ones that are not in scope makes the list grow with the number of routines in
 * the file rather than shrink to what is legal here: one real file offered all
 * 20 names declared anywhere, at a position inside a routine that could see none
 * of them (ISSUES.md I-16). Without a position (no caller context) nothing is
 * filtered, which is the pre-I-16 behaviour.
 */
export function declarationsInScope(
  declarations: DeclaredName[],
  scope?: { line: number; character: number }
): DeclaredName[] {
  if (!scope) return declarations;
  return visibleDeclarationsAt(declarations, scope.line, scope.character);
}

export function buildCompletionItems(
  context: CompletionContextKind,
  linePrefix: string,
  source: string,
  declarations?: DeclaredName[],
  position?: { line: number; character: number }
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
      const declared = declarations
        ? declarationsInScope(declarations, position)
        : declarationsInScope(declarationsFromSource(source), position);
      const declaredItems = declaredItemsFromTree(declared);
      const items = [
        ...functionItems(),
        ...keywordItems(),
        ...treeVarItems(),
        ...typeItems(),
        ...declaredItems,
        ...snippetItems(),
      ];
      return filterByPrefix(
        dedupeByLabel(items, new Set(declaredItems)),
        prefix
      );
    }
  }
}
