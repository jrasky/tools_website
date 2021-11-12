import AWS from 'aws-sdk';
import { PreSignUpExternalProviderTriggerEvent } from 'aws-lambda';

const ssm = new AWS.SSM();

let toolUsersCache: Set<String> | undefined;
async function fetchToolUsers(): Promise<Set<String>> {
    if (toolUsersCache) {
        return toolUsersCache;
    }

    const resp = await ssm.getParameter({ Name: 'tool_users' }).promise();
    
    toolUsersCache = new Set(resp.Parameter?.Value?.split(','));

    return toolUsersCache;
}

export async function handler(event: PreSignUpExternalProviderTriggerEvent): Promise<PreSignUpExternalProviderTriggerEvent> {
    const toolUsers = await fetchToolUsers();
    
    const userEmail = event.request.userAttributes.email;
    
    if (!toolUsers.has(userEmail)) {
        throw new Error(`User ${userEmail} is not authorized`);
    }

    return {
        ...event,
        response: {
            autoConfirmUser: true,
            autoVerifyEmail: true,
            autoVerifyPhone: true,
        },
    };
}
