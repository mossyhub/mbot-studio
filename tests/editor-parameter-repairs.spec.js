import {test, expect} from '@playwright/test';
import {runEditorParameterRepairs} from './editor-parameter-repairs.mjs';

test('actual editor parameter and Setup regression matrix is portable and isolated', async ({browser}, testInfo) => {
  test.setTimeout(120000);
  const summary = await runEditorParameterRepairs({browser, outputDir:testInfo.outputPath('repairs')});
  expect(summary.tests).toBe(24);
  expect(summary.failed).toBe(0);
  expect(summary.passed).toBe(24);
});
