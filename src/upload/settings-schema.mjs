/**
 * A plugin's declared settings, as the bridge relays them to the tray's
 * settings window (and any site that asks).
 *
 * The window draws a form from this with no knowledge of any game, so the
 * schema is the contract: validate it here, drop what cannot be drawn, and say
 * so -- a malformed field must never become a broken control or a crash.
 *
 * Field shapes:
 *   { key, type: 'section', label }                        a heading; holds no value
 *   { key, type: 'boolean', label }
 *   { key, type: 'number', label, min?, max?, optional? }   optional: may be empty (null)
 *   { key, type: 'select' | 'multiselect', label, options: [{ value, label }] }
 *   { key, type: 'rule', label, inputs: [{ key, min?, max? }], joiner?, suffix? }
 *       A switch (its value is `key`) that reads as a sentence with its number
 *       inputs: "[x] ended before wave [100]", "[x] outside tier [ ] to [ ]".
 *       Inputs keep their values while the rule is off, so turning it back on
 *       restores them.
 */
const FIELD_TYPES = new Set(['section', 'boolean', 'number', 'select', 'multiselect', 'rule'])

function readRuleInputs(raw, seenKeys) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const inputs = []
  for (const input of raw) {
    const key = typeof input?.key === 'string' ? input.key.trim() : ''
    if (!key || seenKeys.has(key)) return null
    seenKeys.add(key)
    const normalized = { key }
    if (Number.isFinite(input.min)) normalized.min = input.min
    if (Number.isFinite(input.max)) normalized.max = input.max
    inputs.push(Object.freeze(normalized))
  }
  return inputs
}

function readOptions(raw) {
  if (!Array.isArray(raw)) return []
  const options = []
  const seen = new Set()
  for (const option of raw) {
    const value = typeof option?.value === 'string' ? option.value.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    const label = typeof option.label === 'string' && option.label.trim() ? option.label.trim() : value
    options.push(Object.freeze({ value, label }))
  }
  return options
}

/**
 * @param {unknown} schema the plugin's `settingsSchema`
 * @param {(message: string) => void} [log]
 * @returns {ReadonlyArray<object>} fields that can be drawn, in declared order
 */
export function normalizeSettingsSchema(schema, log = () => {}) {
  if (!Array.isArray(schema)) return []
  const fields = []
  const seen = new Set()
  for (const raw of schema) {
    const key = typeof raw?.key === 'string' ? raw.key.trim() : ''
    if (!key || seen.has(key) || !FIELD_TYPES.has(raw.type)) {
      log(`Ignoring settings field ${JSON.stringify(raw?.key ?? null)}: it needs a unique key and a known type.`)
      continue
    }
    const field = {
      key,
      type: raw.type,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : key,
    }
    if (raw.type === 'number') {
      if (Number.isFinite(raw.min)) field.min = raw.min
      if (Number.isFinite(raw.max)) field.max = raw.max
      field.optional = raw.optional === true
    }
    if (raw.type === 'select' || raw.type === 'multiselect') {
      field.options = readOptions(raw.options)
      if (field.options.length === 0) {
        log(`Ignoring settings field "${key}": a ${raw.type} needs at least one option.`)
        continue
      }
    }
    if (raw.type === 'rule') {
      const inputKeys = new Set([...seen, key])
      const inputs = readRuleInputs(raw.inputs, inputKeys)
      if (!inputs) {
        log(`Ignoring settings rule "${key}": each input needs its own unique key.`)
        continue
      }
      field.inputs = inputs
      if (typeof raw.joiner === 'string' && raw.joiner.trim()) field.joiner = raw.joiner.trim()
      if (typeof raw.suffix === 'string' && raw.suffix.trim()) field.suffix = raw.suffix.trim()
      for (const input of inputs) seen.add(input.key)
    }
    seen.add(key)
    fields.push(Object.freeze(field))
  }
  return fields
}

/** True when this plugin declares settings the bridge can relay. */
export function supportsSettings(plugin) {
  return Boolean(
    plugin
    && Array.isArray(plugin.settingsSchema)
    && typeof plugin.getSettings === 'function'
    && typeof plugin.setSettings === 'function',
  )
}
