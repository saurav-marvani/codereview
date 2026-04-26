import { createLogger } from '@kodus/flow';
import {
    Controller,
    HttpStatus,
    Post,
    Req,
    Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { WebhookEventPayload } from 'resend';

import { ResendClientProvider } from '@libs/common/email/services/resend.client';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

@Public()
@Controller('resend')
export class ResendWebhookController {
    private readonly logger = createLogger(ResendWebhookController.name);

    constructor(private readonly resendClient: ResendClientProvider) {}

    @Post('/webhook')
    async handleWebhook(@Req() req: Request, @Res() res: Response) {
        const svixId = req.headers['svix-id'];
        const svixTimestamp = req.headers['svix-timestamp'];
        const svixSignature = req.headers['svix-signature'];

        if (
            typeof svixId !== 'string' ||
            typeof svixTimestamp !== 'string' ||
            typeof svixSignature !== 'string'
        ) {
            return res
                .status(HttpStatus.BAD_REQUEST)
                .send('Missing Svix headers');
        }

        const rawBody = (req as any).rawBody;
        if (!rawBody) {
            this.logger.error({
                message: 'Resend webhook missing rawBody on request',
                context: ResendWebhookController.name,
            });
            return res
                .status(HttpStatus.INTERNAL_SERVER_ERROR)
                .send('Raw body not captured');
        }

        const payload =
            typeof rawBody === 'string'
                ? rawBody
                : Buffer.isBuffer(rawBody)
                  ? rawBody.toString('utf8')
                  : JSON.stringify(rawBody);

        let event: WebhookEventPayload;
        try {
            event = this.resendClient.getClient().webhooks.verify({
                payload,
                headers: {
                    id: svixId,
                    timestamp: svixTimestamp,
                    signature: svixSignature,
                },
                webhookSecret: this.resendClient.getWebhookSecret(),
            });
        } catch (error) {
            this.logger.warn({
                message: 'Resend webhook signature verification failed',
                context: ResendWebhookController.name,
                metadata: {
                    svixId,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            return res
                .status(HttpStatus.UNAUTHORIZED)
                .send('Invalid signature');
        }

        const data = (event.data ?? {}) as Record<string, unknown>;
        this.logger.log({
            message: `Resend event ${event.type}`,
            context: ResendWebhookController.name,
            metadata: {
                type: event.type,
                createdAt: event.created_at,
                emailId: data.email_id,
                broadcastId: data.broadcast_id,
                to: data.to,
                subject: data.subject,
                svixId,
            },
        });

        return res.status(HttpStatus.OK).send('ok');
    }
}
