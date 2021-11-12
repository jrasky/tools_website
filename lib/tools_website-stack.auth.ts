import fetch from 'node-fetch';
import cookie from 'cookie';
import env from './env.json';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';

interface CognitoTokenResponse {
    id_token: string,
    access_token: string,
    refresh_token: string,
}

interface CognitoRefreshResponse {
    id_token: string,
    access_token: string,
}

interface CognitoErrorResponse {
    error: string,
}

const tokenURL = `https://${env.IDENTITY_DOMAIN}/oauth2/token`;
const tokenRequestHeaders = {
    'Authorization': `Basic ${Buffer.from(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`).toString('base64')}`
};
const cognitoIssuer = `https://cognito-idp.us-east-1.amazonaws.com/${env.USER_POOL}`
const refreshTokenMaxAge = 30 * 24 * 60 * 60; // 30 days in seconds

const JWKS = createRemoteJWKSet(new URL(`${cognitoIssuer}/.well-known/jwks.json`));

export async function handler(event: CloudFrontRequestEvent): Promise<CloudFrontRequestResult> {
    const request = event.Records[0].cf.request;
    const searchParams = new URLSearchParams(request.querystring);
    const cookies = Object.assign({}, ...(request.headers.cookie || [])
        .map(entry => cookie.parse(entry.value)));
    const loginCode = searchParams.get('code');

    // Six possibilities:
    // 1) creds still valid
    // 2) refresh token still valid, creds expired
    // 3) auth code present, new refresh token needs to be fetched
    // 4) no creds/token/auth code present
    // 5) invalid or expired token/code
    // 6) login failed and we have an error code to show the user

    // Check for existing, valid credentials first, in case both creds and a
    // login code are provided.

    // TODO: Have an error page for unauthorized users.

    if (request.uri === '/login' && loginCode) {
        try {
            // case 3: auth code present, new refresh token needs to be fetched
            return {
                status: '307',
                statusDescription: 'Temporary Redirect',
                headers: {
                    'location': [{ value: '/' }],
                    'set-cookie': await getNewCredentials(loginCode)
                }
            };
        } catch (e) {
            console.log('Failed to process new login: ', e);

            return request;
        }
    } else if (request.uri === '/login') {
        // 6: show the user the unauthed view
        return request;
    }

    if (cookies.id_token) {
        try {
            // Check existing credentials
            await checkToken(cookies.id_token);

            // case 1: creds still valid
            return request;
        } catch (e) {
            console.log('Credentials failed validation: ', e);
            // continue and attempt to refresh credentials
        }
    }

    if (cookies.refresh_token) {
        try {
            // case 2: refresh token still valid
            return {
                status: '307',
                statusDescription: 'Temporary Redirect',
                headers: {
                    'location': [{ value: request.uri }],
                    'set-cookie': await refreshCredentials(cookies.refresh_token)
                }
            }
        } catch (e) {
            console.log('Failed to refresh credentials: ', e);
        }
    }

    // case 4: No credentials or
    // case 5: invalid or expired credentials
    return {
        status: '303',
        statusDescription: 'See Other',
        headers: {
            location: [{ value: new URL('?' + new URLSearchParams({
                response_type: 'code',
                client_id: env.CLIENT_ID,
                redirect_uri: env.TOKEN_REDIRECT
            }), `https://${env.IDENTITY_DOMAIN}/login`).toString() }]
        }
    };
}

async function checkToken(id_token: string) {
    // jwtVerify checks the JWT signature, issuer, audience, and expiration
    const { payload } = await jwtVerify(id_token, JWKS, {
        issuer: cognitoIssuer,
        audience: env.CLIENT_ID
    });

    if (payload.token_use !== 'id') {
        throw new Error(`Invalid token use: ${payload.token_use}`);
    }
}

async function getNewCredentials(code: string) {
    const response = await fetch(tokenURL, {
        method: 'POST',
        headers: tokenRequestHeaders,
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            redirect_uri: env.TOKEN_REDIRECT,
            client_id: env.CLIENT_ID,
            code
        })
    });

    if (!response.ok) {
        const { error } = await response.json() as CognitoErrorResponse;
        throw new Error(`Error fetching new credentials: ${response.status} ${response.statusText} ${error}`);
    }

    const { id_token, access_token, refresh_token } = await response.json() as CognitoTokenResponse;

    // Make ID and access session tokens, rely on refresh token for new
    // sessions.
    const idTokenCookie = cookie.serialize('id_token', id_token, { secure: true });
    const accessTokenCookie = cookie.serialize('access_token', access_token, { secure: true });
    const refreshTokenCookie = cookie.serialize('refresh_token', refresh_token, {
        secure: true,
        maxAge: refreshTokenMaxAge
    });

    return [
        { value: idTokenCookie },
        { value: accessTokenCookie },
        { value: refreshTokenCookie }
    ];
}

async function refreshCredentials(refresh_token: string) {
    const response = await fetch(tokenURL, {
        method: 'POST',
        headers: tokenRequestHeaders,
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: env.CLIENT_ID,
            refresh_token
        })
    });

    if (!response.ok) {
        const { error } = await response.json() as CognitoErrorResponse;
        throw new Error(`Error refreshing credentials: ${response.status} ${response.statusText} ${error}`);
    }

    const { id_token, access_token } = await response.json() as CognitoRefreshResponse;

    const idTokenCookie = cookie.serialize('id_token', id_token, { secure: true });
    const accessTokenCookie = cookie.serialize('access_token', access_token, { secure: true });

    return [
        { value: idTokenCookie },
        { value: accessTokenCookie }
    ];
}
