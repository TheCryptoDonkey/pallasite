/**
 * Legal pages — terms of service + privacy notice.
 *
 * Rendered as modal overlays above whatever screen the user is on
 * (no hash router in this codebase). Click the backdrop or press
 * Escape to dismiss.
 *
 * Wording is tuned for UK hobby scale: free prize competition under
 * Schedule 11 of the Gambling Act 2005, 18+ self-attestation only,
 * no purchase required, sats are gifts. No solicitor review at this
 * scale; iterate as the project grows.
 */

import { DEV } from './credits.js';

const MODAL_ID = 'pallasite-legal-modal';

export function openTermsModal(): void {
  openModal('TERMS', termsHtml());
}

export function openPrivacyModal(): void {
  openModal('PRIVACY', privacyHtml());
}

interface ModalRoot extends HTMLElement {
  __onKey?: (e: KeyboardEvent) => void;
}

function openModal(heading: string, contentHtml: string): void {
  closeModal();

  const root = document.createElement('div') as ModalRoot;
  root.id = MODAL_ID;
  root.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);' +
    'display:flex;align-items:center;justify-content:center;padding:20px';

  const panel = document.createElement('div');
  panel.style.cssText =
    'max-width:720px;max-height:85vh;overflow-y:auto;' +
    'background:#050505;border:1px solid #2a2a2a;border-radius:8px;' +
    'padding:24px 28px;color:#ddd;font-size:0.9rem;line-height:1.55';

  const h = document.createElement('h2');
  h.textContent = heading;
  h.style.cssText =
    'margin:0 0 14px 0;color:var(--hud-yellow);letter-spacing:0.18em;font-size:1.4rem';
  panel.appendChild(h);

  const body = document.createElement('div');
  body.innerHTML = contentHtml;
  panel.appendChild(body);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'CLOSE';
  closeBtn.className = 'menu-btn secondary';
  closeBtn.style.cssText = 'margin-top:18px;padding:6px 14px;font-size:0.9rem';
  closeBtn.addEventListener('click', closeModal);
  panel.appendChild(closeBtn);

  root.appendChild(panel);

  root.addEventListener('click', (e) => {
    if (e.target === root) closeModal();
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', onKey);
  root.__onKey = onKey;

  document.body.appendChild(root);
}

function closeModal(): void {
  const existing = document.getElementById(MODAL_ID) as ModalRoot | null;
  if (!existing) return;
  if (existing.__onKey) document.removeEventListener('keydown', existing.__onKey);
  existing.remove();
}

/**
 * Compact legal-link footer. Renders "TERMS · PRIVACY" as a small
 * row that opens the corresponding modal. Pop in at the bottom of
 * any overlay where it makes sense (title, completion, gameover).
 */
export function renderLegalFooter(parent: HTMLElement): void {
  const footer = document.createElement('div');
  footer.style.cssText =
    'display:flex;gap:18px;justify-content:center;align-items:center;' +
    'margin:18px 0 4px;font-size:0.72rem;letter-spacing:0.16em;' +
    'color:rgba(180,180,180,0.55)';

  const mkLink = (label: string, onClick: () => void): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = label;
    a.style.cssText = 'color:inherit;text-decoration:none;cursor:pointer';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return a;
  };

  footer.appendChild(mkLink('TERMS', openTermsModal));
  const dot = document.createElement('span');
  dot.textContent = '·';
  footer.appendChild(dot);
  footer.appendChild(mkLink('PRIVACY', openPrivacyModal));
  parent.appendChild(footer);
}

function termsHtml(): string {
  const npub = DEV.npub;
  return `
    <p>Pallasite is a free arcade game. Skill-based scores can earn small Lightning sats payouts from a community-funded faucet. By claiming sats you agree to these terms.</p>

    <h3>Free prize competition</h3>
    <p>Sats payouts are gifts under a free prize competition (Schedule 11, Gambling Act 2005). No purchase or payment is required to play, claim, or win. Payouts are funded by voluntary donations from the developer and community zaps.</p>

    <h3>Eligibility</h3>
    <p>You must be 18 or older. You must not be a designated person under any UK or international sanctions regime, and you must not be located in a sanctioned jurisdiction. This is a self-attestation — we do not perform technical screening.</p>

    <h3>How claims work</h3>
    <ul>
      <li>Sign in with a Nostr signer (NIP-07 extension or NIP-46 bunker).</li>
      <li>Provide a valid Lightning address (LUD-16) where sats are sent.</li>
      <li>Each claim is recomputed server-side and clamped by the active per-claim, daily, and lifetime caps.</li>
      <li>A cooldown applies between claims, and each claim must beat your personal best for the wave to qualify.</li>
    </ul>

    <h3>Caps and limits</h3>
    <ul>
      <li>Anonymous tier: 100 sats lifetime.</li>
      <li>NIP-05 verified: 500 sats lifetime.</li>
      <li>Signet verified: 2,000 sats lifetime.</li>
      <li>A daily faucet cap, per-claim ceiling, and hourly burst limit apply across all players.</li>
    </ul>

    <h3>No warranty</h3>
    <p>The faucet is provided as-is. We may pause, modify, or discontinue payouts at any time. We are not liable for downstream Lightning Network failures, custodial wallet issues, or losses arising from your use of the game or the faucet.</p>

    <h3>Cheating</h3>
    <p>Runs flagged as cheats (in-game cheat key used, or stat checks failed) are not paid out. Repeated abuse may result in your pubkey being flagged on the server.</p>

    <h3>Contact</h3>
    <p>Reach the developer via Nostr at
      <a href="https://njump.me/${npub}" target="_blank" rel="noopener" style="color:var(--hud-yellow)">${npub.slice(0, 24)}…</a>
    </p>
  `;
}

function privacyHtml(): string {
  return `
    <p>This notice covers what the pallasite-faucet stores and shares.</p>

    <h3>What we store</h3>
    <ul>
      <li>Your Nostr pubkey (hex), as the unique identifier of your claims.</li>
      <li>The Lightning address you provide for each claim.</li>
      <li>Per-claim metadata: score, wave, run duration, payment hash, and a small JSON blob of gameplay telemetry.</li>
      <li>Your IP address transiently, only at rate-limit time. We do not retain persistent IP logs.</li>
    </ul>

    <h3>What we do not store</h3>
    <ul>
      <li>Names, emails, billing details.</li>
      <li>Browser fingerprints or analytics cookies.</li>
      <li>Long-term IP logs.</li>
    </ul>

    <h3>Retention</h3>
    <ul>
      <li>Claim records are kept indefinitely. The corresponding Nostr events are public on relays anyway.</li>
      <li>The internal <code>baseline_log</code> telemetry table is purged once threshold tuning is complete (~4 weeks).</li>
    </ul>

    <h3>Third parties</h3>
    <ul>
      <li>Phoenixd (the on-box Lightning node) handles outbound payments and keeps its own payment records.</li>
      <li>Your Lightning wallet custodian receives the LNURL invoice request and may keep records of incoming payments.</li>
      <li>Nostr relays publicly propagate kind 30762 score events; once published, events cannot be unpublished.</li>
    </ul>

    <h3>Your rights</h3>
    <p>You may request deletion of your server-side records by contacting the developer. We can remove rows from our database but cannot retract events that have already propagated to relays.</p>

    <p>For UK data-protection complaints, see the Information Commissioner's Office:
      <a href="https://ico.org.uk" target="_blank" rel="noopener" style="color:var(--hud-yellow)">ico.org.uk</a>.
    </p>
  `;
}
