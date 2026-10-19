import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { EditorField } from "@prism-fusion/editor-ui";
import { definitionFields, readPath, validateChanges, type Changes } from "./draft.ts";
import { text, type MessageKey } from "./messages.ts";

export interface Choice { value: string | number; label: string }
export interface ReadonlyField { path: string; type: string; reason: string; value?: unknown; hidden?: boolean }
export interface DefinitionFieldProps {
  baseline: unknown; changes: Changes; editablePaths: string[]; readonlyFields: ReadonlyField[];
  backends: Choice[]; providers: Choice[]; models: Choice[]; busy?: boolean; only?: readonly string[];
}
export function useDefinitionFields(props: DefinitionFieldProps, emit: (event: "change", path: string, value: unknown) => void) {
  const { locale } = useI18n();
  const label = (key: MessageKey) => text(key, locale.value);
  const touched = ref(new Set<string>());
  const errors = computed(() => validateChanges(props.baseline, props.changes));
  const fields = computed(() => props.only ? definitionFields.filter(field => props.only!.includes(field.path)) : definitionFields);
  const value = (path: string) => Object.hasOwn(props.changes, path) ? props.changes[path] : readPath(props.baseline, path);
  const allowed = (path: string) => !props.busy && props.editablePaths.includes(path);
  const controls = computed<EditorField[]>(() => fields.value.map(field => {
    const current = value(field.path);
    const error = touched.value.has(field.path) || Object.hasOwn(props.changes, field.path) ? errors.value[field.path] : undefined;
    const errorKey = ({ slug: "slugError", avatar: "avatarError", provider: "providerError" } as Record<string, MessageKey>)[error ?? ""] ?? error;
    const choices = field.kind === "backend" ? props.backends : field.kind === "provider" ? props.providers : props.models;
    return {
      path: field.path, id: `definition${field.path.replaceAll("/", "-")}`, label: label(field.label as MessageKey),
      modelValue: current, kind: field.kind === "boolean" ? "boolean" : field.kind === "textarea" ? "textarea"
        : ["backend", "provider", "model"].includes(field.kind) ? "select" : "text",
      editable: allowed(field.path), rows: field.label === "prompt" ? 8 : 3,
      choices: current && !choices.some(choice => choice.value === current)
        ? [{ value: String(current), label: `${current} (${label("unavailable")})`, disabled: true }, ...choices] : choices,
      emptyLabel: label("inherit"), invalid: !!error,
      hint: errorKey ? label(errorKey as MessageKey) : !props.editablePaths.includes(field.path)
        ? props.readonlyFields.find(item => item.path === field.path)?.reason || label("readonly")
        : field.label === "memory" ? label("memoryNote") : "",
      max: field.max, controlAttrs: { autocomplete: field.label === "name" ? "off" : undefined },
    };
  }));
  function update(path: string, next: string | boolean) {
    const field = fields.value.find(item => item.path === path);
    if (!field || !allowed(path)) return;
    emit("change", path, field.kind === "provider" ? (next ? Number(next) : null) : next);
  }
  const display = (field: ReadonlyField) => field.hidden ? label("preserved")
    : field.value === undefined ? label("unknown") : typeof field.value === "string" ? field.value : JSON.stringify(field.value, null, 2);
  return { controls, update, touched, display, label };
}
