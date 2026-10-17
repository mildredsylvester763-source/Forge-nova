export interface AuthenticatedUser {
  sub: string;
  email: string;
  sid: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}
