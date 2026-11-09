import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { env } from '../env.js';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../lib/http.js';
import { deleteAccount } from '../lib/accounts.js';
import { escapeHtml, renderPage } from '../lib/page.js';

/**
 * Public web pages. Google Play requires a privacy policy URL and a way to
 * delete an account from the web, for people who no longer have the app.
 * Every claim on these pages describes what the code actually does - change
 * the code and the wording together.
 */
const router = Router();

const UPDATED = '7 October 2026';

// Without SUPPORT_EMAIL the pages point at the Play listing, which always has one.
const mailLink = env.supportEmail
  ? `<a href="mailto:${escapeHtml(env.supportEmail)}">${escapeHtml(env.supportEmail)}</a>`
  : null;
const contact = mailLink ? `email ${mailLink}` : 'use the contact email on the xpnz listing in Google Play';
const deleteHelp = mailLink
  ? `Email ${mailLink} from the address you signed up with, and we will delete the account for you.`
  : 'Write to the contact email on the xpnz listing in Google Play, from the address you signed up with, and we will delete the account for you.';

/** Shared by both pages so the two can never disagree about what deletion does. */
const whatDeletionDoes = `
<div class="split">
  <div class="gone">
    <h3>Deleted</h3>
    <ul>
      <li>Your account: name, email and password</li>
      <li>Your income and savings pots</li>
      <li>Every space you own, with everything in it, for everyone in it</li>
      <li>Every event you organised</li>
    </ul>
  </div>
  <div class="kept">
    <h3>Kept, but no longer yours</h3>
    <ul>
      <li>What was recorded in other people's spaces and events. It is part of their books, so it stays there as a plain name, unlinked from any account.</li>
    </ul>
  </div>
</div>`;

/* ----------------------------------------------------------- privacy policy */

router.get('/privacy', (_req, res) => {
  res.send(renderPage({
    title: 'Privacy policy',
    description: 'What the xpnz app stores, who can see it, and how to delete it.',
    body: `
<h1>Privacy policy</h1>
<p class="updated">Last updated ${UPDATED}</p>
<p class="lede">xpnz keeps track of shared money: the cash people hand you, what it is spent on, and who owes whom. This page explains exactly what it stores to do that, who can see it, and how to delete it.</p>

<ul class="glance">
  <li><strong>We store what you type into the app</strong>, plus your name and email. Nothing else about you.</li>
  <li><strong>No ads, no analytics, no tracking.</strong> We never sell or rent your data.</li>
  <li><strong>People you share a space or event with</strong> can see what is recorded in it.</li>
  <li><strong>You can delete your account</strong> at any time, in the app or <a href="/delete-account">on the web</a>.</li>
</ul>

<h2>What we store</h2>
<p><strong>Your account.</strong> Your name, your email address and your password. The password is stored only as a bcrypt hash, a one-way scramble that cannot be turned back into the password, not even by us.</p>
<p><strong>What you record.</strong> Money handed into a shared wallet and taken out; expenses, with their item, category, amount, date, notes, who paid and how they were split; debts cleared; the names of people you add; events and their participants; and your personal income and savings pots.</p>
<p><strong>On your phone.</strong> A sign-in token and the space you last opened, kept in the phone's secure storage so you stay signed in.</p>
<p><strong>Server logs.</strong> When the app talks to our server, the request is logged: IP address, time, the address requested and the app's user agent. These logs are used only to keep the service running and to find faults, and our hosting provider keeps them only briefly.</p>
<p>xpnz does not collect your location, contacts, photos, camera, microphone, or any bank or card details. It never connects to your bank: every amount in it is one somebody typed in.</p>

<h2>How it is used</h2>
<p>Only to run xpnz: to work out balances, debts and reports, to keep your data the same on every phone you sign in on, and to show the people you share with what is in your shared spaces and events. It is not used for advertising, profiling or anything else.</p>

<h2>Who can see it</h2>
<ul>
  <li><strong>People in your spaces.</strong> Everyone who has joined a space sees its people, money, expenses and debts, including entries with your name on them.</li>
  <li><strong>People in your events.</strong> Everyone in an event sees its participants, expenses and who owes whom.</li>
  <li><strong>Only you</strong> see your personal income and savings pots.</li>
  <li><strong>Service providers</strong> that run the app for us and handle data only to do that: Vercel hosts the server, Neon hosts the database, and Expo delivers app updates (it sees the app version and basic device details when the app checks for one).</li>
  <li><strong>Authorities</strong>, only if the law requires us to disclose something.</li>
</ul>

<h2>How it is protected</h2>
<p>Everything sent between the app and the server is encrypted with HTTPS. Passwords are only ever stored hashed. Every request is checked against your sign-in token, and the server only returns data from spaces and events you belong to.</p>

<h2>Keeping and deleting your data</h2>
<p>Your data is kept for as long as your account exists. You can delete your account at any time, in the app under <strong>More → Delete account</strong>, or <a href="/delete-account">on the web</a> if you no longer have the app. Deletion is immediate and permanent:</p>
${whatDeletionDoes}
<p style="margin-top:16px">Deleted data can remain in our database provider's backups for up to 30 days before it is gone for good.</p>

<h2>Children</h2>
<p>xpnz is not meant for children under 13, and we do not knowingly collect their data. If you believe a child has made an account, contact us and we will delete it.</p>

<h2>Changes</h2>
<p>If this policy changes, this page and the date at the top will be updated.</p>

<h2>Contact</h2>
<p>For questions or requests about your data, ${contact}.</p>
`,
  }));
});

/* ------------------------------------------------------ account deletion */

function deletePage({ email = '', error = null } = {}) {
  return renderPage({
    title: 'Delete your account',
    description: 'Permanently delete your xpnz account and its data.',
    body: `
<h1>Delete your account</h1>
<p class="lede">This permanently deletes your xpnz account and the data that belongs to it. It cannot be undone.</p>
${error ? `<p class="notice error" role="alert">${escapeHtml(error)}</p>` : ''}

<h2>From the app</h2>
<p>Open xpnz, go to <strong>More → Delete account</strong>, and enter your password.</p>

<h2>Or here, without the app</h2>
<form method="post" action="/delete-account">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <label class="check"><input type="checkbox" name="confirm" required> I understand my account and the data below are deleted for good.</label>
  <button type="submit">Delete my account</button>
</form>

<h2>What happens</h2>
${whatDeletionDoes}
<p style="margin-top:16px">Forgot your password? ${deleteHelp}</p>
`,
  });
}

router.get('/delete-account', (_req, res) => {
  res.send(deletePage());
});

router.post('/delete-account', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || !password || !req.body.confirm) {
    return res.status(400).send(deletePage({ email, error: 'Enter your email and password, and tick the box to confirm.' }));
  }

  const { rows: [user] } = await query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  // Same message either way - don't reveal which emails have an account.
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).send(deletePage({ email, error: 'Incorrect email or password.' }));
  }

  await withTransaction((client) => deleteAccount(client, user.id));

  return res.send(renderPage({
    title: 'Account deleted',
    description: 'Your xpnz account has been deleted.',
    body: `
<h1>Account deleted</h1>
<p class="notice done" role="status">Your xpnz account and its data have been deleted.</p>
<p class="lede">If the app is still on your phone, it will sign you out the next time you open it. You can uninstall it.</p>
`,
  }));
}));

export default router;
