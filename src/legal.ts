/**
 * Legal pages — terms of use + privacy notice.
 *
 * Rendered as modal overlays above whatever screen the user is on
 * (no hash router in this codebase). Click the backdrop or press
 * Escape to dismiss.
 *
 * Wording is tuned for UK hobby scale. Pallasite is a free arcade game open
 * to all ages. Sats payouts ended on 23 October 2026 and no claims can be
 * made, so there is no prize competition, eligibility or age gating text.
 * Tips remain voluntary gifts that buy nothing. No solicitor review at this
 * scale; iterate as the project grows.
 */

import { DEV } from './credits.js';
import {
  versionChipText, versionChipColour, subscribeVersionState, checkForUpdate,
} from './version.js';

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
    'display:flex;flex-direction:column;gap:6px;justify-content:center;align-items:center;' +
    'margin:18px 0 4px;font-size:0.72rem;letter-spacing:0.16em;' +
    'color:rgba(180,180,180,0.55)';

  const linksRow = document.createElement('div');
  linksRow.style.cssText = 'display:flex;gap:18px;align-items:center;';

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

  linksRow.appendChild(mkLink('TERMS', openTermsModal));
  const dot = document.createElement('span');
  dot.textContent = '·';
  linksRow.appendChild(dot);
  linksRow.appendChild(mkLink('PRIVACY', openPrivacyModal));
  footer.appendChild(linksRow);

  // Build chip — clickable, forces a fresh /version.json check. Three states
  // (latest / stale / offline) each colour-coded so the player can see at a
  // glance whether they're on the current build, especially on mobile PWA
  // where there's no URL bar to inspect.
  const chip = document.createElement('a');
  chip.href = '#';
  chip.style.cssText =
    'text-decoration:none;cursor:pointer;font-size:0.66rem;letter-spacing:0.18em;';
  function paintChip(): void {
    chip.textContent = versionChipText();
    chip.style.color = versionChipColour();
  }
  paintChip();
  const unsubscribe = subscribeVersionState(paintChip);
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    void checkForUpdate();
  });
  // Tear down the subscription if the footer leaves the DOM (overlay swap).
  // MutationObserver is overkill; the next renderTitle/renderRecap clears the
  // overlay root, so leaking listeners is bounded — but be tidy anyway.
  const obs = new MutationObserver(() => {
    if (!document.body.contains(chip)) {
      unsubscribe();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  footer.appendChild(chip);
  parent.appendChild(footer);
}

function termsHtml(): string {
  const npub = DEV.npub;
  return `
    <p>Pallasite is a free arcade game, open to players of any age. Sats payouts ended on 23 October 2026. No claims can be made, and nothing in the game pays out real money or anything else of value.</p>

    <h3>Playing the game</h3>
    <p>Flying the ship, surviving waves, posting high scores and sharing run cards is free for everyone. No sign-in is required to play. The sats counter in the game is a score-style tally only. It has no cash value and cannot be withdrawn.</p>

    <h3>Tips</h3>
    <p>Tips and donations are voluntary gifts. They buy nothing: no features, power-ups, perks or any other advantage are unlocked by tipping, and tipping does not affect your scores. Tips are not refundable.</p>

    <h3>No warranty</h3>
    <p>The game is provided as-is. We may change, pause or discontinue any part of it at any time. We are not liable for losses arising from your use of the game.</p>

    <h3>Cheating</h3>
    <p>Runs flagged as cheats by automated checks may be hidden from leaderboards.</p>

    <h3>Contact</h3>
    <p>Reach the developer via Nostr at
      <a href="https://njump.me/${npub}" target="_blank" rel="noopener" style="color:var(--hud-yellow)">${npub.slice(0, 24)}…</a>
    </p>
  `;
}

function privacyHtml(): string {
  return `
    <p>This notice covers what Pallasite stores and shares. Sats payouts ended on 23 October 2026, so the game no longer takes Lightning addresses or processes claims.</p>

    <h3>On your device</h3>
    <ul>
      <li>Settings, high scores, streaks, unlocks and a local guest identity (a Nostr key made in your browser) are kept in your browser's local storage. Clearing site data removes them.</li>
      <li>No names, emails, billing details, analytics cookies or browser fingerprints are collected.</li>
    </ul>

    <h3>Nostr relays</h3>
    <p>Scores, ghosts, replays, skin unlocks and live-play events are published as signed Nostr events to public relays under your Nostr public key, and scores may appear on third-party leaderboards. Once published, events cannot be unpublished or recalled from relays.</p>

    <h3>Past claims</h3>
    <p>Records of past claims are held by the operator and will be deleted.</p>
    <!-- [DECISION: delete the faucet claim records on the host, then change this sentence to say they were deleted on <date>.] -->

    <h3>Game services</h3>
    <p>The game's server API, which handled payouts, has been switched off and now answers every request with an error. Phone controllers and multiplayer connect through the game's controller service, which passes control messages between devices.</p>

    <h3>Tips</h3>
    <p>Tips are voluntary gifts sent directly to the developer's public Lightning address, Geyser page or Ko-fi page. The game does not receive, check or store any record of a tip, and a tip unlocks nothing. Your wallet provider may keep its own records.</p>

    <h3>Your rights</h3>
    <p>You may ask the developer to delete any records the operator holds about you. We cannot retract events that have already propagated to relays.</p>

    <p>For UK data-protection complaints, see the Information Commissioner's Office:
      <a href="https://ico.org.uk" target="_blank" rel="noopener" style="color:var(--hud-yellow)">ico.org.uk</a>.
    </p>
  `;
}
