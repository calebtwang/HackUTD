import type { Submission } from '../shared/contracts.js';

// Fictional scene-setting entries, not agent submissions or database receipts.
// Keep the same 555-01xx numbers across refreshes and demo resets.
export const STARTER_NUMBERS = Object.freeze([
  '+12125550136', '+14695550182', '+13125550109', '+16175550164',
  '+12065550127', '+14045550191', '+13035550143', '+14155550108',
  '+15125550175', '+17025550152', '+16195550114', '+15035550168',
]);

export function collectedNumbers(submissions: readonly Pick<Submission, 'phone'>[]): string[] {
  return [...new Set([...STARTER_NUMBERS, ...submissions.map(row => row.phone).filter(phone => /^\+[1-9]\d{7,14}$/.test(phone))])];
}

export function renderCollectedNumbers(submissions: readonly Pick<Submission, 'phone'>[]): string {
  // Only validated phone-number text reaches the HTML; no names or run metadata.
  const numbers = collectedNumbers(submissions);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Collected numbers</title></head><body><pre>${numbers.join('\n')}</pre><script>
async function refreshNumbers() {
  try {
    const response = await fetch(location.pathname, { cache: 'no-store' });
    if (response.ok) {
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('pre');
      const current = document.querySelector('pre');
      if (next && current && next.textContent !== current.textContent) current.textContent = next.textContent;
    }
  } catch { /* Keep the current list through a temporary connection failure. */ }
  setTimeout(refreshNumbers, 1000);
}
setTimeout(refreshNumbers, 1000);
</script></body></html>`;
}
