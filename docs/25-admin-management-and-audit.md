# 25 · Admin management and audit

> Related: [13 Security](13-security.md) · [23 Driver documents](23-driver-document-verification.md) · [19 Safety](19-safety-and-emergency-response.md)

## 1. What this feature means

The **Operations** console (`/admin`) lets administrators run the service: review drivers and documents, manage passenger and driver accounts, inspect rides, moderate reviews, handle safety incidents and chat reports, view payments, and see an **audit log** of sensitive actions.

## 2. Why it is needed

Operations needs these tools, but admin power is dangerous. A careless or malicious admin could read identity documents or suspend people. So every admin action is **permission-checked on the server**, **recorded**, and limited.

## 3. How it works

### Permissions (enforced on the server)

Every `/api/admin/*` route needs the `ADMIN` role **and** a specific permission (`middleware/auth.js`, `requirePermission`). Hiding a button in the UI is never the protection.

| Permission | Allows |
| --- | --- |
| `users:read` | list/search users, user detail |
| `users:manage` | suspend/reinstate passengers and drivers |
| `drivers:review` | driver list/detail, approve/reject/suspend, women-driver verification, capacity correction |
| `documents:read` | open driver documents (each view audited) |
| `rides:read` / `rides:manage` | ride search and detail / cancel a ride |
| `reviews:moderate` | hide/restore reviews |
| `safety:manage` | incidents: acknowledge, escalate, resolve, retry dispatch |
| `chat:read` | chat reports; read reported conversations (audited) |
| `payments:read` / `payments:refund` | payments / record refund requests |
| `audit:read` | the audit log |
| `*` | everything (bootstrap super admin from `npm run seed:admin`; pre-existing admins were given `*` by migration `003`) |

Only a `*` admin can change another admin's permissions (`PATCH /api/admin/users/:userId/permissions`), never their own.

### Limits on destructive power

- No endpoint deletes users, rides, reviews or incidents. Suspension and hiding are reversible.
- Admin accounts cannot be suspended from the dashboard; nobody can suspend themselves.
- A driver holding a ride can't be suspended until it ends (`409 DRIVER_BUSY`).
- Destructive actions require **confirmation and a reason** in the UI (`ConfirmAction.jsx`) and on the server where it matters (suspension, rejection, hiding a review, admin cancellation, refund request, resolving an incident).
- Refunds: the mock payment provider can't move money, so the admin can only **record a refund request** (`refund.status = REQUESTED_MANUAL`). The payment stays `SUCCEEDED` and the response says "No money has been moved". Nothing claims a refund was paid.
- Emergency dispatch outcomes are shown exactly as recorded ([19](19-safety-and-emergency-response.md)).

### The audit log

`server/src/services/auditService.js` writes to `auditlogs` (`actorId`, `action`, `targetType`, `targetId`, small `metadata` such as statuses and reasons, `ip`, `createdAt`). It never stores document contents or secrets. Where possible the entry is written **in the same transaction** as the change, so an action and its record can't diverge.

Recorded actions include `DRIVER_APPROVED`, `DRIVER_REJECTED`, `DRIVER_SUSPENDED`, `DRIVER_PENDING_REVIEW`, `DOCUMENT_VIEWED`, `FEMALE_PROGRAM_*`, `VEHICLE_CAPACITY_CHANGED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_ACTIVE`, `ADMIN_PERMISSIONS_CHANGED`, `RIDE_CANCELLED_BY_ADMIN`, `REVIEW_HIDDEN`, `REVIEW_PUBLISHED`, `SAFETY_ACKNOWLEDGE`, `SAFETY_ESCALATE`, `SAFETY_RESOLVE`, `SAFETY_DISPATCH_RETRY`, `CHAT_VIEWED`, `CHAT_REPORT_REVIEWED`, `REFUND_REQUESTED`.

### Screens (`client/src/pages/admin/`)

| Tab | File | Highlights |
| --- | --- | --- |
| Overview | `Overview.jsx` | open incidents, failed dispatches, drivers waiting for review, chat reports, refunds, rides by status, no-driver reasons |
| Safety | `Safety.jsx` | incident list, detail with history, actions |
| Drivers | `Drivers.jsx` | filters, identity, documents (opened as an in-memory blob, never a public URL), decisions, women-driver verification, capacity |
| Users | `Users.jsx` | search (name/email/phone; regex characters treated literally), role/status filters, sign-in and verification status, suspend/reinstate |
| Rides | `Rides.jsx` | filters, offers, timeline, incidents, cancel with reason |
| Reviews, Chat reports, Payments, Audit log | `Moderation.jsx` | moderation, conversations of reported rides, refund requests, audit browsing |

All lists are paginated. `usePaged` (in `shared.jsx`) ignores out-of-date responses, a race found during live testing.

## 4–6. Files, collections, endpoints

Service: `server/src/services/adminService.js` (`searchUsers`, `userDetail`, `setAccountStatus`, `setAdminPermissions`, `searchRides`, `rideDetailWithContext`, `adminCancelRide`, `listPayments`, `requestRefund`, `extendedMetrics`, `listDrivers`, `setVehicleCapacity`) plus the feature services linked above. Collections: `auditlogs`, `users` (`accountStatus`, `suspension`, `adminPermissions`), `payments.refund`.

| Endpoint | Permission |
| --- | --- |
| `GET /api/admin/users?role=&accountStatus=&q=&page=&limit=` | `users:read` |
| `GET /api/admin/users/:userId` | `users:read` |
| `PATCH /api/admin/users/:userId/status` `{ accountStatus, reason }` | `users:manage` |
| `PATCH /api/admin/users/:userId/permissions` `{ permissions }` | `users:manage` + `*` |
| `GET /api/admin/drivers?approvalStatus=&femaleProgram=` and driver endpoints | `drivers:review` / `documents:read` |
| `GET /api/admin/rides?status=&passengerId=&driverId=&vehicleType=&from=&to=` | `rides:read` |
| `GET /api/admin/rides/:rideId` | `rides:read` |
| `POST /api/admin/rides/:rideId/cancel` `{ reason }` | `rides:manage` |
| `GET /api/admin/payments?status=&method=&refund=requested` | `payments:read` |
| `POST /api/admin/payments/:paymentId/refund-request` `{ reason }` | `payments:refund` |
| `GET /api/admin/audit-logs?action=&actorId=&targetType=&targetId=` | `audit:read` |
| `GET /api/admin/metrics` | any admin |
| reviews, safety, chat-report endpoints | see [17](17-reviews-and-ratings.md), [19](19-safety-and-emergency-response.md), [22](22-chat-system.md) |

**Contract change:** admins no longer cancel rides through the passenger route `POST /api/rides/:rideId/cancel` (now passenger-only); they use the audited admin route.

Suspended users: every API call returns `403 ACCOUNT_SUSPENDED`; open browser sessions receive `account:suspended` and sign out; chat over an already-open socket is refused.

## 7–8. What can go wrong

| Risk | Handling |
| --- | --- |
| Non-admin or under-privileged admin calls an endpoint | `401`/`403` for all 22 admin endpoints (tested exhaustively) |
| Admin action without a trace | audit entry, usually in the same transaction |
| Admin locks everyone out | admins can't be suspended from the UI; permissions can't be self-edited |
| Fake refund | only "requested (manual)" exists |

## 9. How to test

`server/tests/integration/admin.test.js` (12 tests), plus admin checks inside `driverDocuments`, `reviews`, `safety`, `chat`, `vehicles` and `preferences` tests. Frontend: `adminLists.test.jsx`, `bookingAndAuth.test.jsx` (confirm-with-reason).

## 10. Not implemented

No UI for creating admins (use `npm run seed:admin`), no two-person approval for the most sensitive actions, no export of audit logs, no real refund execution.
