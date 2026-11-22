# Auth Flow

1. Client requests OTP
2. OTP Sent -> `OtpVerification` created
3. Client verifies OTP
4. Tokens Issued -> `RefreshToken` and `UserSession` created
5. Token Rotation happens periodically
6. Logout -> `UserSession` and `RefreshToken` revoked
