// Bare rules are family prefixes; '*' is the only wildcard. Match model IDs,
// including provider-qualified names, without treating the provider as a model.
export function parseIgnoredQuotaModels(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...new Set(value.split(/[\s,;，；]+/u).map(v => v.trim().toLowerCase())
    .filter(v => v.length > 0 && v.length <= 256))].slice(0, 100)
}

function matches(model: string, rule: string): boolean {
  if (!rule.includes('*')) return model.startsWith(rule)
  const parts = rule.split('*'), prefix = parts.shift()!, suffix = parts.pop() || ''
  if (!model.startsWith(prefix) || !model.endsWith(suffix) || model.length < prefix.length + suffix.length) return false
  let at = prefix.length
  const end = model.length - suffix.length
  for (const part of parts) {
    const found = model.indexOf(part, at)
    if (found < 0 || found + part.length > end) return false
    at = found + part.length
  }
  return true
}

export function ignoredQuotaModel(model: string, rules: readonly string[]): string | undefined {
  const name = model.trim().toLowerCase()
  if (!name) return undefined
  const unqualified = name.split('/').at(-1) || name
  return rules.find(rule => matches(rule.includes('/') ? name : unqualified, rule.toLowerCase()))
}
