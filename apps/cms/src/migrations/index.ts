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
import * as migration_20261003_155740_review_preview_jobs from './20261003_155740_review_preview_jobs';
import * as migration_20261003_160000_publish_queue_correctness from './20261003_160000_publish_queue_correctness';
import * as migration_20261003_160100_review_comments from './20261003_160100_review_comments';
import * as migration_20261003_163801_inquiry_lead_pipeline from './20261003_163801_inquiry_lead_pipeline';
import * as migration_20261003_165038_redirect_lifecycle from './20261003_165038_redirect_lifecycle';
import * as migration_20261003_171753_media_library from './20261003_171753_media_library';
import * as migration_20261003_181059 from './20261003_181059';
import * as migration_20261003_191650_theme_settings_selection from './20261003_191650_theme_settings_selection';
import * as migration_20261003_200100_site_settings from './20261003_200100_site_settings';
import * as migration_20261003_210000_search_controls from './20261003_210000_search_controls';
import * as migration_20261003_220000_style_guides from './20261003_220000_style_guides';
import * as migration_20261003_230000_section_landing_page from './20261003_230000_section_landing_page';
import * as migration_20261003_230100_scheduled_publications from './20261003_230100_scheduled_publications';
import * as migration_20261003_230200_scheduled_publication_dispatch from './20261003_230200_scheduled_publication_dispatch';
import * as migration_20261003_230300_business_case_metadata from './20261003_230300_business_case_metadata';
import * as migration_20261003_240000_integration_configurations from './20261003_240000_integration_configurations';
import * as migration_20261004_000000_mail_authorizations from './20261004_000000_mail_authorizations';
import * as migration_20261004_010000_provider_ledger from './20261004_010000_provider_ledger';
import * as migration_20261004_020000_configured_ai_jobs from './20261004_020000_configured_ai_jobs';
import * as migration_20261004_030000_page_type_metadata from './20261004_030000_page_type_metadata';
import * as migration_20261004_031000_page_creation_receipts from './20261004_031000_page_creation_receipts';
import * as migration_20261004_235511_media_immutable_versions from './20261004_235511_media_immutable_versions';
import * as migration_20261005_114210_site_identity_navigation_1_5 from './20261005_114210_site_identity_navigation_1_5';
import * as migration_20261005_133859 from './20261005_133859';
import * as migration_20261005_145826_mailbox_workspace from './20261005_145826_mailbox_workspace';
import * as migration_20261005_230000_mail_threads from './20261005_230000_mail_threads';
import * as migration_20261005_231000_notification_user_preferences from './20261005_231000_notification_user_preferences';
import * as migration_20261005_164500_crawler_policy_1_7 from './20261005_164500_crawler_policy_1_7';
import * as migration_20261005_170000_redirect_creator_attribution from './20261005_170000_redirect_creator_attribution';
import * as migration_20261005_180000_inquiry_spam_lifecycle from './20261005_180000_inquiry_spam_lifecycle';
import * as migration_20261005_181000_application_contact_fields from './20261005_181000_application_contact_fields';
import * as migration_20261005_190000_retention_privacy from './20261005_190000_retention_privacy';
import * as migration_20261005_191000_mail_replies from './20261005_191000_mail_replies';
import * as migration_20261005_200000_notification_delivery from './20261005_200000_notification_delivery';

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
    up: migration_20261003_155740_review_preview_jobs.up,
    down: migration_20261003_155740_review_preview_jobs.down,
    name: '20261003_155740_review_preview_jobs',
  },
  {
    up: migration_20261003_160000_publish_queue_correctness.up,
    down: migration_20261003_160000_publish_queue_correctness.down,
    name: '20261003_160000_publish_queue_correctness',
  },
  {
    up: migration_20261003_160100_review_comments.up,
    down: migration_20261003_160100_review_comments.down,
    name: '20261003_160100_review_comments',
  },
  {
    up: migration_20261003_163801_inquiry_lead_pipeline.up,
    down: migration_20261003_163801_inquiry_lead_pipeline.down,
    name: '20261003_163801_inquiry_lead_pipeline',
  },
  {
    up: migration_20261003_165038_redirect_lifecycle.up,
    down: migration_20261003_165038_redirect_lifecycle.down,
    name: '20261003_165038_redirect_lifecycle',
  },
  {
    up: migration_20261003_171753_media_library.up,
    down: migration_20261003_171753_media_library.down,
    name: '20261003_171753_media_library',
  },
  {
    up: migration_20261003_181059.up,
    down: migration_20261003_181059.down,
    name: '20261003_181059',
  },
  {
    up: migration_20261003_191650_theme_settings_selection.up,
    down: migration_20261003_191650_theme_settings_selection.down,
    name: '20261003_191650_theme_settings_selection',
  },
  {
    up: migration_20261003_200100_site_settings.up,
    down: migration_20261003_200100_site_settings.down,
    name: '20261003_200100_site_settings',
  },
  {
    up: migration_20261003_210000_search_controls.up,
    down: migration_20261003_210000_search_controls.down,
    name: '20261003_210000_search_controls',
  },
  {
    up: migration_20261003_220000_style_guides.up,
    down: migration_20261003_220000_style_guides.down,
    name: '20261003_220000_style_guides',
  },
  {
    up: migration_20261003_230000_section_landing_page.up,
    down: migration_20261003_230000_section_landing_page.down,
    name: '20261003_230000_section_landing_page',
  },
  {
    up: migration_20261003_230100_scheduled_publications.up,
    down: migration_20261003_230100_scheduled_publications.down,
    name: '20261003_230100_scheduled_publications',
  },
  {
    up: migration_20261003_230200_scheduled_publication_dispatch.up,
    down: migration_20261003_230200_scheduled_publication_dispatch.down,
    name: '20261003_230200_scheduled_publication_dispatch',
  },
  {
    up: migration_20261003_230300_business_case_metadata.up,
    down: migration_20261003_230300_business_case_metadata.down,
    name: '20261003_230300_business_case_metadata',
  },
  {
    up: migration_20261003_240000_integration_configurations.up,
    down: migration_20261003_240000_integration_configurations.down,
    name: '20261003_240000_integration_configurations',
  },
  {
    up: migration_20261004_000000_mail_authorizations.up,
    down: migration_20261004_000000_mail_authorizations.down,
    name: '20261004_000000_mail_authorizations',
  },
  {
    up: migration_20261004_010000_provider_ledger.up,
    down: migration_20261004_010000_provider_ledger.down,
    name: '20261004_010000_provider_ledger',
  },
  {
    up: migration_20261004_020000_configured_ai_jobs.up,
    down: migration_20261004_020000_configured_ai_jobs.down,
    name: '20261004_020000_configured_ai_jobs',
  },
  {
    up: migration_20261004_030000_page_type_metadata.up,
    down: migration_20261004_030000_page_type_metadata.down,
    name: '20261004_030000_page_type_metadata',
  },
  {
    up: migration_20261004_031000_page_creation_receipts.up,
    down: migration_20261004_031000_page_creation_receipts.down,
    name: '20261004_031000_page_creation_receipts',
  },
  {
    up: migration_20261004_235511_media_immutable_versions.up,
    down: migration_20261004_235511_media_immutable_versions.down,
    name: '20261004_235511_media_immutable_versions',
  },
  {
    up: migration_20261005_114210_site_identity_navigation_1_5.up,
    down: migration_20261005_114210_site_identity_navigation_1_5.down,
    name: '20261005_114210_site_identity_navigation_1_5',
  },
  {
    up: migration_20261005_133859.up,
    down: migration_20261005_133859.down,
    name: '20261005_133859',
  },
  {
    up: migration_20261005_145826_mailbox_workspace.up,
    down: migration_20261005_145826_mailbox_workspace.down,
    name: '20261005_145826_mailbox_workspace',
  },
  {
    up: migration_20261005_164500_crawler_policy_1_7.up,
    down: migration_20261005_164500_crawler_policy_1_7.down,
    name: '20261005_164500_crawler_policy_1_7'
  },
  {
    up: migration_20261005_170000_redirect_creator_attribution.up,
    down: migration_20261005_170000_redirect_creator_attribution.down,
    name: '20261005_170000_redirect_creator_attribution',
  },
  {
    up: migration_20261005_180000_inquiry_spam_lifecycle.up,
    down: migration_20261005_180000_inquiry_spam_lifecycle.down,
    name: '20261005_180000_inquiry_spam_lifecycle',
  },
  {
    up: migration_20261005_181000_application_contact_fields.up,
    down: migration_20261005_181000_application_contact_fields.down,
    name: '20261005_181000_application_contact_fields',
  },
  {
    up: migration_20261005_190000_retention_privacy.up,
    down: migration_20261005_190000_retention_privacy.down,
    name: '20261005_190000_retention_privacy',
  },
  {
    up: migration_20261005_191000_mail_replies.up,
    down: migration_20261005_191000_mail_replies.down,
    name: '20261005_191000_mail_replies',
  },
  {
    up: migration_20261005_200000_notification_delivery.up,
    down: migration_20261005_200000_notification_delivery.down,
    name: '20261005_200000_notification_delivery',
  },
  {
    up: migration_20261005_230000_mail_threads.up,
    down: migration_20261005_230000_mail_threads.down,
    name: '20261005_230000_mail_threads',
  },
  { up: migration_20261005_231000_notification_user_preferences.up, down: migration_20261005_231000_notification_user_preferences.down, name: '20261005_231000_notification_user_preferences' },
];
