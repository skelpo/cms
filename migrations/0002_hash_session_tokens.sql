-- Session tokens are now stored hashed (sha256) instead of in plaintext, so a
-- DB leak can't be replayed to hijack a session. Existing rows hold plaintext
-- tokens that can never match a hashed lookup, so clear them; every user simply
-- signs in again once. (apiTokens were already hashed, so they're unaffected.)
DELETE FROM `sessions`;
