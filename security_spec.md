# Nimo Security Specification & Invariants

## 1. Data Invariants
1. **User Isolation & PII Segregation**: Every user profile (`/users/{userId}`) and private PII record (`/users/{userId}/private/{docId}`) is readable and writable exclusively by the verified owner (`request.auth.uid == userId && request.auth.token.email_verified == true`). Blanket listing of `/users` is forbidden.
2. **Thread Ownership Master Gate**: A `ChatMessage` at `/chatThreads/{threadId}/messages/{messageId}` can only be read or written if the parent `/chatThreads/{threadId}` document exists and its `ownerId == request.auth.uid`.
3. **Strict Identity & Immutability**: On creation, `ownerId` (or `uid`) must match `request.auth.uid` and cannot be modified on update. `createdAt` must equal `request.time` on creation and remain immutable on update. `updatedAt` must equal `request.time` on both creation and update.
4. **Strict Field Allowlisting & Size Bounds**: Every document write validates exact required/allowed keys (`keys().hasAll(...) && keys().hasOnly(...)`), types, enum values, regex IDs (`^[a-zA-Z0-9_\-]+$`), and string lengths to block shadow fields and resource exhaustion.
5. **Secure List Queries**: Every `allow list` rule evaluates `resource.data.ownerId == request.auth.uid` without `get()` or `exists()` lookups.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Identity Spoofing on Create**: `chatThreads/t1` with `ownerId: "victim_uid"` while signed in as `"attacker_uid"` -> `PERMISSION_DENIED`.
2. **Shadow Field Injection**: `chatThreads/t1` with valid fields plus `{ isAdmin: true }` -> `PERMISSION_DENIED`.
3. **Unverified Email Write**: Authenticated user with `email_verified: false` creating a `vocabItems/v1` -> `PERMISSION_DENIED`.
4. **Client Timestamp Forgery**: `codeSnippets/s1` with `createdAt: "1999-01-01T00:00:00Z"` instead of `serverTimestamp()` -> `PERMISSION_DENIED`.
5. **Owner Hijack on Update**: Updating `codeSnippets/s1` to change `ownerId` -> `PERMISSION_DENIED`.
6. **CreatedAt Mutation on Update**: Updating `chatThreads/t1` with modified `createdAt` -> `PERMISSION_DENIED`.
7. **ID Poisoning Path**: Creating `studyNotes/` with a 300-character ID or invalid characters (`../admin`) -> `PERMISSION_DENIED`.
8. **Orphaned Message Write**: Creating `chatThreads/nonexistent/messages/m1` where parent thread does not exist or belongs to another user -> `PERMISSION_DENIED`.
9. **ThreadId Mismatch in Message**: Creating `chatThreads/t1/messages/m1` with `threadId: "t2"` -> `PERMISSION_DENIED`.
10. **PII Leak Attempt**: Signed-in User B reading `/users/userA/private/info` -> `PERMISSION_DENIED`.
11. **Unscoped List Query**: Querying `collection(db, 'vocabItems')` without `where('ownerId', '==', uid)` -> `PERMISSION_DENIED`.
12. **Resource Exhaustion Payload**: Creating `codeSnippets/s1` with a 100KB `code` string exceeding `40000` bytes -> `PERMISSION_DENIED`.
