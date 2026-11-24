import { assert, test } from 'orca/testing'
import { ignoredQuotaModel, parseIgnoredQuotaModels } from './model-filter'

test('model rules accept families and wildcards with common separators and no duplicate case variants', () => {
  const rules = parseIgnoredQuotaModels(' GPT,gemini*；gpt\n*flash*，claude-opus; ')
  assert.deepEqual(rules, ['gpt', 'gemini*', '*flash*', 'claude-opus'])
  for (const model of ['gpt-6-sol', 'GPT-6-SOL', 'gateway/gpt-6-sol', 'vendor/Gemini-4-pro', 'preview-flash-001'])
    assert.ok(ignoredQuotaModel(model, rules))
  assert.equal(ignoredQuotaModel('claude-sonnet', rules), undefined)
  assert.equal(ignoredQuotaModel('', ['*']), undefined)
  assert.deepEqual(parseIgnoredQuotaModels(undefined), [])
})

test('model rules match the model rather than a provider prefix and treat regex syntax as plain text', () => {
  assert.equal(ignoredQuotaModel('gemini-gateway/claude-opus', ['gemini']), undefined)
  assert.equal(ignoredQuotaModel('other/gpt-6-sol', ['other/gpt*']), 'other/gpt*')
  assert.equal(ignoredQuotaModel('gpt-6-sol', ['gpt-*-sol']), 'gpt-*-sol')
  assert.equal(ignoredQuotaModel('gpt-6-sol-extra', ['gpt-*-sol']), undefined)
  assert.equal(ignoredQuotaModel('aaa', ['*a']), '*a')
  assert.equal(ignoredQuotaModel('gpt-6', ['gpt.*']), undefined)
})
