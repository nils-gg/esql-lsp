/**
 * ESQL hover documentation.
 *
 * Ported from joaquinvulcano/esql-vscode (MIT — see ATTRIBUTION.md) and
 * extended with data types and parser domains. Word lookup runs on masked
 * lines, so hovering inside a string literal or comment yields nothing.
 */

import { Hover } from 'vscode-languageserver';
import { scan } from './scanner';
import {
  ESQL_FUNCTIONS,
  ESQL_MESSAGE_TREE_VARS,
  ESQL_DOMAINS,
  ESQL_TYPES,
} from './data/esqlData';

interface WordMatch {
  word: string;
  start: number;
  end: number;
}

function wordAt(line: string, character: number): WordMatch | null {
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (character >= m.index && character <= m.index + m[0].length) {
      return { word: m[0], start: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

export function hoverAt(
  source: string,
  line: number,
  character: number
): Hover | null {
  const { lines } = scan(source);
  const maskedLine = lines[line];
  if (maskedLine === undefined) return null;

  const w = wordAt(maskedLine, character);
  if (!w) return null;

  const upper = w.word.toUpperCase();

  // Built-in function
  const fn = ESQL_FUNCTIONS.find((f) => f.name.toUpperCase() === upper);
  if (fn) {
    let md = `### \`${fn.name}\`\n\nESQL built-in function\n\n\`\`\`esql\n${fn.signature}\n\`\`\`\n\n${fn.description}`;
    if (fn.returnType) {
      md += `\n\n**Returns:** \`${fn.returnType}\``;
    }
    if (fn.example) {
      md += `\n\n**Example:**\n\n\`\`\`esql\n${fn.example}\n\`\`\``;
    }
    return { contents: { kind: 'markdown', value: md } };
  }

  // Message tree variable (case-insensitive, shown in canonical case)
  const treeVar = ESQL_MESSAGE_TREE_VARS.find((v) => v.name.toUpperCase() === upper);
  if (treeVar) {
    return {
      contents: {
        kind: 'markdown',
        value:
          `### \`${treeVar.name}\`\n\n` +
          `**ESQL message tree variable**\n\n${treeVar.description}`,
      },
    };
  }

  // Parser / domain
  const domain = ESQL_DOMAINS.find((d) => d.name.toUpperCase() === upper);
  if (domain) {
    return {
      contents: {
        kind: 'markdown',
        value:
          `### \`${domain.name}\`\n\n` +
          `**ESQL parser / message domain** — ${domain.detail}\n\n${domain.description}`,
      },
    };
  }

  // Data type
  const type = ESQL_TYPES.find((t) => t.name.toUpperCase() === upper);
  if (type) {
    return {
      contents: {
        kind: 'markdown',
        value: `### \`${type.name}\`\n\n**ESQL data type**\n\n${type.description}`,
      },
    };
  }

  return null;
}
