/**
 * Dirty Dozen Security Test Specification for Nimo Firestore Rules
 * Run against Firebase Emulator Suite when testing locally.
 */
export const dirtyDozenCases = [
  { name: '1. Identity spoofing on chatThreads create', collection: 'chatThreads', expect: 'PERMISSION_DENIED' },
  { name: '2. Shadow field injection (isAdmin: true)', collection: 'chatThreads', expect: 'PERMISSION_DENIED' },
  { name: '3. Unverified email write', collection: 'vocabItems', expect: 'PERMISSION_DENIED' },
  { name: '4. Client timestamp forgery on codeSnippets create', collection: 'codeSnippets', expect: 'PERMISSION_DENIED' },
  { name: '5. Owner hijack on codeSnippets update', collection: 'codeSnippets', expect: 'PERMISSION_DENIED' },
  { name: '6. Immutable createdAt mutation on chatThreads update', collection: 'chatThreads', expect: 'PERMISSION_DENIED' },
  { name: '7. Oversized or invalid document ID', collection: 'studyNotes', expect: 'PERMISSION_DENIED' },
  { name: '8. Orphaned message write without owned parent thread', collection: 'chatThreads/missing/messages', expect: 'PERMISSION_DENIED' },
  { name: '9. Mismatched threadId inside message payload', collection: 'chatThreads/t1/messages', expect: 'PERMISSION_DENIED' },
  { name: '10. Cross-user PII read on /users/{other}/private/info', collection: 'users/other/private', expect: 'PERMISSION_DENIED' },
  { name: '11. Unscoped list query without ownerId filter', collection: 'vocabItems', expect: 'PERMISSION_DENIED' },
  { name: '12. Oversized 100KB code payload exceeding 40000 bytes', collection: 'codeSnippets', expect: 'PERMISSION_DENIED' },
] as const;
