export type ModelIcon = 'claude' | 'gpt' | 'deepseek' | 'zap'
export type ModelCategory = 'Claude' | 'GPT' | 'Deepseek' | 'Gemini' | 'Aiden' | 'Traex' | 'byted' | 'Seed'

export function modelCategory(model: string): ModelCategory | null {
  const name = model.toLowerCase()
  for (const category of ['Seed', 'byted', 'Aiden', 'Traex', 'Claude', 'GPT', 'Deepseek', 'Gemini'] as const)
    if (name.includes(category.toLowerCase())) return category
  return null
}

/** Match the actual model name, including provider prefixes, without case sensitivity. */
export function modelIcon(model: string): ModelIcon {
  // Category prefixes take precedence in labels; icons still describe the model family.
  const name = model.toLowerCase()
  if (name.includes('claude')) return 'claude'
  if (name.includes('gpt')) return 'gpt'
  if (name.includes('deepseek')) return 'deepseek'
  return 'zap'
}
