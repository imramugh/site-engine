import * as migration_20261003_032726_initial_foundation from './20261003_032726_initial_foundation';
import * as migration_20261003_032907_add_user_email_and_section_summary from './20261003_032907_add_user_email_and_section_summary';

export const migrations = [
  {
    up: migration_20261003_032726_initial_foundation.up,
    down: migration_20261003_032726_initial_foundation.down,
    name: '20261003_032726_initial_foundation',
  },
  {
    up: migration_20261003_032907_add_user_email_and_section_summary.up,
    down: migration_20261003_032907_add_user_email_and_section_summary.down,
    name: '20261003_032907_add_user_email_and_section_summary'
  },
];
