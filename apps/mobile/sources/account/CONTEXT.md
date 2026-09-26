# Local session credentials

The approved link grant supplies a device credential and private key. The account module stores and clears them locally; it does not contact an operated account service. A link failure never erases the grant. Logout removes the local registration and pairing credentials.

See `application/tokenStorage.ts`, `presentation/AuthContext.tsx`, and `pairing/application/hostedE2ee.ts`.
