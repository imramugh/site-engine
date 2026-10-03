import * as migration_20261003_032726_initial_foundation from './20261003_032726_initial_foundation';
import * as migration_20261003_032907_add_user_email_and_section_summary from './20261003_032907_add_user_email_and_section_summary';
import * as migration_20261003_033755_identity_session_foundation from './20261003_033755_identity_session_foundation';
import * as migration_20261003_033949_invitation_token_binding from './20261003_033949_invitation_token_binding';
import * as migration_20261003_034216_oidc_issuer_binding from './20261003_034216_oidc_issuer_binding';
import * as migration_20261003_034628_emergency_totp_and_csrf from './20261003_034628_emergency_totp_and_csrf';

export const migrations = [
  {
    up: migration_20261003_032726_initial_foundation.up,
    down: migration_20261003_032726_initial_foundation.down,
    name: '20261003_032726_initial_foundation',
  },
  {
    up: migration_20261003_032907_add_user_email_and_section_summary.up,
    down: migration_20261003_032907_add_user_email_and_section_summary.down,
    name: '20261003_032907_add_user_email_and_section_summary',
  },
  {
    up: migration_20261003_033755_identity_session_foundation.up,
    down: migration_20261003_033755_identity_session_foundation.down,
    name: '20261003_033755_identity_session_foundation',
  },
  {
    up: migration_20261003_033949_invitation_token_binding.up,
    down: migration_20261003_033949_invitation_token_binding.down,
    name: '20261003_033949_invitation_token_binding',
  },
  {
    up: migration_20261003_034216_oidc_issuer_binding.up,
    down: migration_20261003_034216_oidc_issuer_binding.down,
    name: '20261003_034216_oidc_issuer_binding',
  },
  {
    up: migration_20261003_034628_emergency_totp_and_csrf.up,
    down: migration_20261003_034628_emergency_totp_and_csrf.down,
    name: '20261003_034628_emergency_totp_and_csrf'
  },
];
