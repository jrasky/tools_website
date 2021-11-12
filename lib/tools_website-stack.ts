import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as s3 from '@aws-cdk/aws-s3';
import * as s3_deployment from '@aws-cdk/aws-s3-deployment';
import * as route53 from '@aws-cdk/aws-route53';
import * as route53_targets from '@aws-cdk/aws-route53-targets';
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

export class ToolsWebsiteStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const toolUsersParameter = ssm.StringListParameter.fromStringListParameterName(this,
      'ToolUsersParam', '/tool_users');

    const preSignUp = new lambda_nodejs.NodejsFunction(this, 'cognito-signup', {
      timeout: cdk.Duration.seconds(5),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });
    toolUsersParameter.grantRead(preSignUp);

    const userPool = new cognito.UserPool(this, 'ToolUsers', {
      selfSignUpEnabled: false,
      lambdaTriggers: { preSignUp },
    });

    const domain = userPool.addDomain('AuthDomain', {
      cognitoDomain: { domainPrefix: this.node.tryGetContext('cognitoDomainPrefix') }
    });

    const googleAppId = ssm.StringParameter.fromStringParameterName(this, 'GoogleAppId',
      '/google_app_id').stringValue;

    const googleAppSecret = ssm.StringParameter.fromStringParameterName(this, 'GoogleAppSecret', 
      '/google_app_secret').stringValue;

    const identityProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool,
      clientId: googleAppId,
      clientSecret: googleAppSecret,
      scopes: ['profile', 'email', 'openid'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
      }
    });

    const appClient = userPool.addClient('WebsiteAuth', {
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      generateSecret: true,
      preventUserExistenceErrors: true,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [this.node.tryGetContext('tokenRedirect')]
      },
    });
    appClient.node.addDependency(identityProvider);

    const cdnTriggerAssets = new s3.Bucket(this, 'CDNTriggerAssets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
    });

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
                '--external:*/env.json --minify',
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

    const onEventHandler = new lambda_nodejs.NodejsFunction(this, 'rebundle-env', {
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
        TOKEN_REDIRECT: this.node.tryGetContext('tokenRedirect'),
      },
    });
    cdnTriggerAssets.grantReadWrite(onEventHandler);
    onEventHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:DescribeUserPoolClient'],
      resources: [userPool.userPoolArn]
    }));

    const rebundleEnv = new cr.Provider(this, 'RebundleEnv', {
      onEventHandler,
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
    const authHandlerVersion = new lambda.Version(this, `auth-${bundleKeyPrefix}`, {
      lambda: authHandler,
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'ToolsHostedZone', {
      hostedZoneId: this.node.tryGetContext('hostedZoneId'),
      zoneName: this.node.tryGetContext('hostedZoneName'),
    });

    const cert = new acm.Certificate(this, 'Certificate', {
      domainName: zone.zoneName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const assetsBucket = new s3.Bucket(this, 'WebsiteAssets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
    });

    new s3_deployment.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3_deployment.Source.asset('./node_modules/tools_website_assets/build')],
      destinationBucket: assetsBucket
    });

    const cdn = new cloudfront.Distribution(this, 'WebsiteCDN', {
      defaultBehavior: {
         origin: new origins.S3Origin(assetsBucket),
         edgeLambdas: [{
           functionVersion: authHandlerVersion,
           eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
         }],
         viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      domainNames: [zone.zoneName],
      certificate: cert,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new route53.ARecord(this, 'Alias', {
      zone,
      target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(cdn)),
    });

    new route53.AaaaRecord(this, 'AAAAlias', {
      zone,
      target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(cdn)),
    });
  }
}
