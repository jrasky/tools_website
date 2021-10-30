import * as cdk from '@aws-cdk/core';
import * as s3 from '@aws-cdk/aws-s3';
import * as s3_deployment from '@aws-cdk/aws-s3-deployment';
import * as route53 from '@aws-cdk/aws-route53';
import * as acm from '@aws-cdk/aws-certificatemanager';
import * as cloudfront from '@aws-cdk/aws-cloudfront';
import * as origins from '@aws-cdk/aws-cloudfront-origins';
import * as cognito from '@aws-cdk/aws-cognito';
import * as ssm from '@aws-cdk/aws-ssm';
import * as lambda from '@aws-cdk/aws-lambda';
import * as lambda_nodejs from '@aws-cdk/aws-lambda-nodejs';
import * as logs from '@aws-cdk/aws-logs';
import * as cr from '@aws-cdk/custom-resources';
import { execSync } from 'child_process';
import os from 'os';

const HOSTED_ZONE_ID = 'Z006455334LOCYI1M47TX';
const TOKEN_REDIRECT = 'https://tools.rasky.co/login';

export class ToolsWebsiteStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneId(this, 'ToolsHostedZone', HOSTED_ZONE_ID);

    const cert = new acm.Certificate(this, 'Certificate', {
      domainName: 'tools.rasky.co',
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const assetsBucket = new s3.Bucket(this, 'WebsiteAssets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
    });

    const cdnTriggerAssets = new s3.Bucket(this, 'CDNTriggerAssets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
    });

    const googleAppId = ssm.StringParameter.fromStringParameterName(this, 'GoogleAppId',
      '/googleAppId',
    ).stringValue;

    const googleAppSecret = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'GoogleAppSecret', {
      parameterName: '/googleAppSecret',
      version: 1,
    }).stringValue;

    const userPool = new cognito.UserPool(this, 'ToolUsers', {
      selfSignUpEnabled: false,
      lambdaTriggers: {
        preSignUp: new lambda_nodejs.NodejsFunction(this, 'cognito-signup', {
          timeout: cdk.Duration.seconds(5),
          logRetention: logs.RetentionDays.ONE_MONTH,
        }),
      },
    });

    const domain = userPool.addDomain('AuthDomain', {
      cognitoDomain: { domainPrefix: 'rasky-tool-users' }
    });

    new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool,
      clientId: googleAppId,
      clientSecret: googleAppSecret,
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
      }
    });

    const appClient = userPool.addClient('WebsiteAuth', {
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      preventUserExistenceErrors: true,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: ['https://tools.rasky.co/login']
      },
    })

    const bundleKeyPrefix = new Date().toISOString();
    const authBundle = new s3_deployment.BucketDeployment(this, 'AuthBundle', {
      sources: [s3_deployment.Source.asset('lib', {
        bundling: {
          image: cdk.DockerImage.fromRegistry('dummy'),
          local: {
            tryBundle(outputDir: string) {
              execSync([
                'npx esbuild lib/tools_website-stack.auth.ts',
                '--bundle --platform=node --external:aws-sdk',
                '--external:*.json --minify',
                `--outfile=${outputDir}/index.js`
              ].join(' '));

              return true;
            }
          }
        }
      })],
      destinationBucket: cdnTriggerAssets,
      destinationKeyPrefix: bundleKeyPrefix,
    });

    const rebundleEnv = new cr.Provider(this, 'RebundleEnv', {
      onEventHandler: new lambda_nodejs.NodejsFunction(this, 'rebundle-env', {
        timeout: cdk.Duration.minutes(5),
        logRetention: logs.RetentionDays.ONE_MONTH,
        environment: {
          USER_POOL: userPool.userPoolId,
          IDENTITY_DOMAIN: cdk.Fn.join('.', [
            domain.domainName,
            'auth',
            this.region,
            'amazoncognito.com'
          ]),
          CLIENT_ID: appClient.userPoolClientId,
          TOKEN_REDIRECT,
        },
      }),
      logRetention: logs.RetentionDays.ONE_MONTH,
    })

    const rebundledAuthHandler = new cdk.CustomResource(this, 'RebundledAuth', {
      serviceToken: rebundleEnv.serviceToken,
      properties: {
        payloadBucket: cdnTriggerAssets.bucketName,
        payloadKey: `${bundleKeyPrefix}/index.js`,
        outputKey: `${bundleKeyPrefix}/auth_bundle.zip`,
      },
    });
    rebundledAuthHandler.node.addDependency(authBundle);

    const authHandler = new cloudfront.experimental.EdgeFunction(this, 'auth', {
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'index.handler',
      code: lambda.Code.fromBucket(
        cdnTriggerAssets,
        rebundledAuthHandler.getAttString('outputKey')),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    new cloudfront.Distribution(this, 'WebsiteCDN', {
      defaultBehavior: {
         origin: new origins.S3Origin(assetsBucket),
         edgeLambdas: [{
           functionVersion: authHandler.currentVersion,
           eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
         }]
      },
      defaultRootObject: 'index.html',
      domainNames: ['tools.rasky.co'],
      certificate: cert,
    });
  }
}
