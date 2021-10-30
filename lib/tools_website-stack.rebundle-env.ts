import AWS from 'aws-sdk';
import JSZip from 'jszip';

interface ResourceProperties {
    /** Bucket that stores assets */
    payloadBucket: string,

    /** Key for index.js payload */
    payloadKey: string,

    /** Output key to put the zipped bundle in */
    outputKey: string,
}

interface CustomProperties {
    outputBucket: string,
    outputKey: string,
}

interface CreateEvent {
    RequestType: 'Create',
    LogicalResourceId: string,
    ResourceProperties: ResourceProperties,
    ResourceType: string,
    RequestId: string,
    StackId: string,
}

interface UpdateEvent {
    RequestType: 'Update',
    LogicalResourceId: string,
    PhysicalResourceId: string,
    ResourceProperties: ResourceProperties,
    OldResourceProperties: ResourceProperties,
    ResourceType: string,
    RequestId: string,
    StackId: string,
}

interface DeleteEvent {
    RequestType: 'Delete',
    LogicalResourceId: string,
    PhysicalResourceId: string,
    ResourceProperties: ResourceProperties,
    ResourceType: string,
    RequestId: string,
    StackId: string,
}

type Event = CreateEvent | UpdateEvent | DeleteEvent;

interface Response {
    PhysicalResourceId?: string,
    Data?: CustomProperties,
}

const s3 = new AWS.S3();
const cognito = new AWS.CognitoIdentityServiceProvider();

/*
 * Environment variables we expect:
 * USER_POOL: user pool ID
 * IDENTITY_DOMAIN: domain name for cognito hosted domain
 * TOKEN_REDIRECT: login redirect URL
 * CLIENT_ID: app client ID
 * 
 * We obtain:
 * CLIENT_SECRET: app client secret for the app client
 */

async function injectPayload(props: ResourceProperties) {
    const appClient = await cognito.describeUserPoolClient({
        UserPoolId: process.env.USER_POOL as string,
        ClientId: process.env.CLIENT_ID as string,
    }).promise();

    const env = {
        USER_POOL: process.env.USER_POOL,
        IDENTITY_DOMAIN: process.env.IDENTITY_DOMAIN,
        TOKEN_REDIRECT: process.env.TOKEN_REDIRECT,
        CLIENT_ID: process.env.CLIENT_ID,
        CLIENT_SECRET: appClient.UserPoolClient?.ClientSecret,
    };

    const zip = new JSZip();

    const response = await s3.getObject({
        Bucket: props.payloadBucket,
        Key: props.payloadKey,
    }).promise();

    zip.file('index.js', response.Body as Buffer);
    zip.file('env.json', JSON.stringify(env));
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    await s3.putObject({
        Body: zipBuffer,
        Bucket: props.payloadBucket,
        Key: props.outputKey,
    }).promise();
}

export async function handler(event: Event): Promise<Response> {
    switch (event.RequestType) {
        case 'Create':
        case 'Update':
            await injectPayload(event.ResourceProperties);
        default:
    }

    return {
        Data: {
            outputBucket: event.ResourceProperties.payloadBucket,
            outputKey: event.ResourceProperties.outputKey,
        }
    }
}