import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = path.join(packageRoot, "src", "templates");
const outputPath = path.join(packageRoot, "src", "generated", "templates.generated.ts");

function asNonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, rawValue]) => {
      const normalized = asNonEmptyString(rawValue);
      // Strip trailing ? from key for the runtime record (optionality is a type-level concern)
      const cleanKey = key.replace(/\?$/u, "");
      return normalized ? [[cleanKey, normalized]] : [];
    }),
  );
}

/**
 * Parse the variables field from frontmatter, preserving optionality info.
 * Returns an array of { name, description, optional } objects.
 */
function parseVariables(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, rawValue]) => {
    const description = asNonEmptyString(rawValue);
    if (!description) return [];
    const optional = key.endsWith("?");
    const name = optional ? key.slice(0, -1) : key;
    return [{ name, description, optional }];
  });
}

function toTemplateId(fileName) {
  const baseName = fileName.replace(/\.md$/u, "");
  const segments = baseName.split("-");
  return segments
    .map((segment, index) =>
      index === 0 ? segment : `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`,
    )
    .join("");
}

/**
 * Extract variable references from a template body.
 * Returns the set of variable names referenced (excluding partial references).
 */
function extractBodyReferences(body) {
  const references = new Set();

  // Match {{variableName}}, {{{variableName}}}, and {{#if variableName}}
  // but NOT {{> partialName}}, {{/if}}, {{else}}
  const pattern = /\{\{\{?(?:#if\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\}?\}\}/gu;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    references.add(match[1]);
  }

  return references;
}

/**
 * Validate that body references match declared variables.
 * Errors on undeclared references, warns on unreferenced declarations.
 */
function validateVariables(templateId, declaredVars, body) {
  const declaredNames = new Set(declaredVars.map((v) => v.name));
  const bodyRefs = extractBodyReferences(body);
  const errors = [];

  // Check for body references not declared in frontmatter
  for (const ref of bodyRefs) {
    if (!declaredNames.has(ref)) {
      errors.push(`Template "${templateId}": body references "{{${ref}}}" but it is not declared in frontmatter variables`);
    }
  }

  // Warn for declared variables not referenced in body
  for (const name of declaredNames) {
    if (!bodyRefs.has(name)) {
      console.warn(`Warning: Template "${templateId}": variable "${name}" is declared in frontmatter but not referenced in template body`);
    }
  }

  return errors;
}

const fileNames = (await readdir(templatesDir))
  .filter((fileName) => fileName.endsWith(".md"))
  .sort();

const definitions = [];
const allVariableInfo = [];
const validationErrors = [];

for (const fileName of fileNames) {
  const raw = await readFile(path.join(templatesDir, fileName), "utf8");
  const parsed = matter(raw);
  const kind = asNonEmptyString(parsed.data.kind) ?? "prompt";
  const id = toTemplateId(fileName);
  const variablesParsed = parseVariables(parsed.data.variables);
  const body = parsed.content.trim();

  definitions.push({
    id,
    body,
    fileName,
    kind,
    title: asNonEmptyString(parsed.data.title),
    summary: asNonEmptyString(parsed.data.summary),
    intent: asNonEmptyString(parsed.data.intent),
    editingNotes: asNonEmptyString(parsed.data.editingNotes),
    variables: asStringRecord(parsed.data.variables),
  });

  allVariableInfo.push({ id, variables: variablesParsed });

  // Validate body references against declared variables
  const errors = validateVariables(id, variablesParsed, body);
  validationErrors.push(...errors);
}

if (validationErrors.length > 0) {
  for (const error of validationErrors) {
    console.error(`Error: ${error}`);
  }
  process.exit(1);
}

// Generate TemplateVariables interface
function generateTemplateVariablesInterface(variableInfos) {
  const lines = [];
  lines.push("export interface TemplateVariables {");
  for (const { id, variables } of variableInfos) {
    if (variables.length === 0) {
      lines.push(`  ${id}: Record<string, never>;`);
    } else {
      lines.push(`  ${id}: {`);
      for (const { name, optional } of variables) {
        const optionalMark = optional ? "?" : "";
        lines.push(`    ${name}${optionalMark}: string;`);
      }
      lines.push("  };");
    }
  }
  lines.push("}");
  return lines.join("\n");
}

const templateVariablesBlock = generateTemplateVariablesInterface(allVariableInfo);

const output = `/* eslint-disable */
// Generated by packages/templates/scripts/generate-templates.mjs. Do not edit directly.

export const templateDefinitions = ${JSON.stringify(definitions, null, 2)} as const;

${templateVariablesBlock}

export type TemplateId = keyof TemplateVariables;
`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");
