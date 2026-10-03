# ENG-021: Implement careers, private applications, and hiring access

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Templates job
- Strategy §9 Careers

## User story
As a hiring user, I want job postings and applications managed privately so applicants can apply and resumes stay protected.

## Acceptance criteria
- [ ] Create job pages from open roles with location, type, work mode, closing date, rich-text fields, and JobPosting schema.
- [ ] Implement application validation, consent, resume type/size limits, and explicit error states.
- [ ] Store resumes outside public media with short-lived signed access links.
- [ ] Support Hiring and Owner access only; stages, notes, notification recipient, and reply timeline.
- [ ] Closing a role removes it from public listings but preserves its applications.

## Test requirements
- **Unit:** Test role access, application field validation, signed-link expiry, and closing visibility.
- **Integration:** Submit an application and retrieve a resume through a permitted signed link.

## Browser scenarios
- Given a public user requests a stored resume URL, when no valid signed token is supplied, then access is denied.
- Given a closed role, when its listing is viewed, then it is absent while a Hiring user can still view applications.

## Dependencies
- ENG-006
- ENG-007
- ENG-010

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.
