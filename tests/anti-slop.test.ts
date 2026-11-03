import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { it } from 'vite-plus/test'

const runNode = promisify(execFile)

it('rejects module mocking through Vite+ while allowing injected spies and unrelated helpers', async () => {
  // Run the native RuleTester in its own process, without adding vendored TS sources
  // to the application's typecheck or sharing its native parser state with Vitest.
  const script = `
    import { RuleTester } from ${JSON.stringify(import.meta.resolve('vite-plus/lint/plugins-dev'))}
    import { noModuleMockingRule } from ${JSON.stringify(new URL('../tools/oxlint/anti-slop/rules/no-module-mocking.ts', import.meta.url).href)}

    const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
    const error = { messageId: 'moduleMock' }
    tester.run('anti-slop/no-module-mocking', noModuleMockingRule, {
      valid: [
        "import { vi } from 'vite-plus/test'; vi.fn(); vi.spyOn({ save() {} }, 'save')",
        "const vi = { mock() {} }; vi.mock()",
        "import { vi } from './helpers'; vi.mock('./dependency')",
      ],
      invalid: [
        { code: "import { vi } from 'vite-plus/test'; vi.mock('./dependency')", errors: [error] },
        { code: "import { vi as testApi } from 'vite-plus/test'; testApi.doMock('./dependency')", errors: [error] },
        { code: "import { vi as testApi } from 'vite-plus/test'; testApi['mock']('./dependency')", errors: [error] },
        { code: "import { vi } from 'vitest'; vi.mock('./dependency')", errors: [error] },
        { code: "import { jest } from '@jest/globals'; jest.mock('./dependency')", errors: [error] },
      ],
    })
  `
  await runNode(process.execPath, ['--input-type=module', '--eval', script], { windowsHide: true })
})
