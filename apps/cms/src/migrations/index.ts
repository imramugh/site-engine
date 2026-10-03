import * as migration_20261003_032726_initial_foundation from './20261003_032726_initial_foundation';
import * as migration_20261003_032907_add_user_email_and_section_summary from './20261003_032907_add_user_email_and_section_summary';
import * as migration_20261003_033755_identity_session_foundation from './20261003_033755_identity_session_foundation';
import * as migration_20261003_033949_invitation_token_binding from './20261003_033949_invitation_token_binding';
import * as migration_20261003_034216_oidc_issuer_binding from './20261003_034216_oidc_issuer_binding';
import * as migration_20261003_034628_emergency_totp_and_csrf from './20261003_034628_emergency_totp_and_csrf';
import * as migration_20261003_042858_invitation_required_subject from './20261003_042858_invitation_required_subject';
import * as migration_20261003_133520_scoped_page_slugs from './20261003_133520_scoped_page_slugs';
import * as migration_20261003_135539_editorial_change_set_lifecycle from './20261003_135539_editorial_change_set_lifecycle';
import * as migration_20261003_143750 from './20261003_143750';
import * as migration_20261003_144959 from './20261003_144959';
import * as migration_20261003_150050 from './20261003_150050';
import * as migration_20261003_160000_publish_queue_correctness from './20261003_160000_publish_queue_correctness';

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
    name: '20261003_034628_emergency_totp_and_csrf',
  },
  {
    up: migration_20261003_042858_invitation_required_subject.up,
    down: migration_20261003_042858_invitation_required_subject.down,
    name: '20261003_042858_invitation_required_subject',
  },
  {
    up: migration_20261003_133520_scoped_page_slugs.up,
    down: migration_20261003_133520_scoped_page_slugs.down,
    name: '20261003_133520_scoped_page_slugs',
  },
  {
    up: migration_20261003_135539_editorial_change_set_lifecycle.up,
    down: migration_20261003_135539_editorial_change_set_lifecycle.down,
    name: '20261003_135539_editorial_change_set_lifecycle',
  },
  {
    up: migration_20261003_143750.up,
    down: migration_20261003_143750.down,
    name: '20261003_143750',
  },
  {
    up: migration_20261003_144959.up,
    down: migration_20261003_144959.down,
    name: '20261003_144959',
  },
  {
    up: migration_20261003_150050.up,
    down: migration_20261003_150050.down,
    name: '20261003_150050',
  },
  {
    up: migration_20261003_160000_publish_queue_correctness.up,
    down: migration_20261003_160000_publish_queue_correctness.down,
    name: '20261003_160000_publish_queue_correctness'
  },
];
