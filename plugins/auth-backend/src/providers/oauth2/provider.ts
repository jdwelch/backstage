/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import express from 'express';
import passport from 'passport';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';
import { Logger } from 'winston';
import { TokenIssuer } from '../../identity';
import { OAuthProvider } from '../../lib/OAuthProvider';
import {
  executeFetchUserProfileStrategy,
  executeFrameHandlerStrategy,
  executeRedirectStrategy,
  executeRefreshTokenStrategy,
  makeProfileInfo,
} from '../../lib/PassportStrategyHelper';
import {
  AuthProviderConfig,
  OAuthProviderOptions,
  OAuthProviderHandlers,
  OAuthResponse,
  PassportDoneCallback,
  RedirectInfo,
} from '../types';
import { Config } from '@backstage/config';

type PrivateInfo = {
  refreshToken: string;
};

export type OAuth2AuthProviderOptions = OAuthProviderOptions & {
  authorizationUrl: string;
  tokenUrl: string;
};

export class OAuth2AuthProvider implements OAuthProviderHandlers {
  private readonly _strategy: OAuth2Strategy;

  constructor(options: OAuth2AuthProviderOptions) {
    this._strategy = new OAuth2Strategy(
      {
        clientID: options.clientId,
        clientSecret: options.clientSecret,
        callbackURL: options.callbackUrl,
        authorizationURL: options.authorizationUrl,
        tokenURL: options.tokenUrl,
        passReqToCallback: false as true,
      },
      (
        accessToken: any,
        refreshToken: any,
        params: any,
        rawProfile: passport.Profile,
        done: PassportDoneCallback<OAuthResponse, PrivateInfo>,
      ) => {
        const profile = makeProfileInfo(rawProfile, params.id_token);
        done(
          undefined,
          {
            providerInfo: {
              idToken: params.id_token,
              accessToken,
              scope: params.scope,
              expiresInSeconds: params.expires_in,
            },
            profile,
          },
          {
            refreshToken,
          },
        );
      },
    );
  }

  async start(
    req: express.Request,
    options: Record<string, string>,
  ): Promise<RedirectInfo> {
    const providerOptions = {
      ...options,
      accessType: 'offline',
      prompt: 'consent',
    };
    return await executeRedirectStrategy(req, this._strategy, providerOptions);
  }

  async handler(
    req: express.Request,
  ): Promise<{ response: OAuthResponse; refreshToken: string }> {
    const { response, privateInfo } = await executeFrameHandlerStrategy<
      OAuthResponse,
      PrivateInfo
    >(req, this._strategy);

    return {
      response: await this.populateIdentity(response),
      refreshToken: privateInfo.refreshToken,
    };
  }

  async refresh(refreshToken: string, scope: string): Promise<OAuthResponse> {
    const { accessToken, params } = await executeRefreshTokenStrategy(
      this._strategy,
      refreshToken,
      scope,
    );

    const profile = await executeFetchUserProfileStrategy(
      this._strategy,
      accessToken,
      params.id_token,
    );

    return this.populateIdentity({
      providerInfo: {
        accessToken,
        idToken: params.id_token,
        expiresInSeconds: params.expires_in,
        scope: params.scope,
      },
      profile,
    });
  }

  // Use this function to grab the user profile info from the token
  // Then populate the profile with it
  private async populateIdentity(
    response: OAuthResponse,
  ): Promise<OAuthResponse> {
    const { profile } = response;

    if (!profile.email) {
      throw new Error('Profile does not contain a profile');
    }

    const id = profile.email.split('@')[0];

    return { ...response, backstageIdentity: { id } };
  }
}

export function createOAuth2Provider(
  config: AuthProviderConfig,
  _: string,
  envConfig: Config,
  _logger: Logger,
  tokenIssuer: TokenIssuer,
) {
  const providerId = 'oauth2';
  const clientId = envConfig.getString('clientId');
  const clientSecret = envConfig.getString('clientSecret');
  const callbackUrl = `${config.baseUrl}/${providerId}/handler/frame`;
  const authorizationUrl = envConfig.getString('authorizationUrl');
  const tokenUrl = envConfig.getString('tokenUrl');

  const provider = new OAuth2AuthProvider({
    clientId,
    clientSecret,
    callbackUrl,
    authorizationUrl,
    tokenUrl,
  });

  return OAuthProvider.fromConfig(config, provider, {
    disableRefresh: false,
    providerId,
    tokenIssuer,
  });
}
