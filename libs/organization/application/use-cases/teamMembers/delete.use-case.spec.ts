import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { DeleteUserUseCase } from '@libs/identity/application/use-cases/user/delete.use-case';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { NotificationChannel } from '@libs/notifications/domain/enums/channel.enum';
import { TEAM_MEMBERS_SERVICE_TOKEN } from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';

import { DeleteTeamMembersUseCase } from './delete.use-case';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('DeleteTeamMembersUseCase — org.member_removed emit', () => {
    let useCase: DeleteTeamMembersUseCase;
    let teamMembers: {
        findOne: jest.Mock;
        findManyByUser: jest.Mock;
        countByUser: jest.Mock;
        deleteMembers: jest.Mock;
    };
    let deleteUser: { execute: jest.Mock };
    let notify: { emit: jest.Mock };

    const REMOVED_USER = {
        uuid: 'user-1',
        name: 'Alex Rivera',
        email: 'alex@acme.com',
    };
    const MEMBER = {
        uuid: 'tm-1',
        user: REMOVED_USER,
        team: { uuid: 'team-1', name: 'Engineering' },
        organization: { uuid: 'org-1', name: 'Acme Inc' },
    };

    beforeEach(async () => {
        teamMembers = {
            findOne: jest.fn().mockResolvedValue(MEMBER),
            findManyByUser: jest.fn().mockResolvedValue([MEMBER]),
            countByUser: jest.fn().mockResolvedValue(1),
            deleteMembers: jest.fn().mockResolvedValue(undefined),
        };
        deleteUser = { execute: jest.fn().mockResolvedValue(undefined) };
        notify = { emit: jest.fn().mockResolvedValue(undefined) };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DeleteTeamMembersUseCase,
                { provide: TEAM_MEMBERS_SERVICE_TOKEN, useValue: teamMembers },
                { provide: DeleteUserUseCase, useValue: deleteUser },
                { provide: NotificationService, useValue: notify },
                {
                    provide: REQUEST,
                    useValue: {
                        user: {
                            uuid: 'admin-1',
                            email: 'admin@acme.com',
                            organization: { uuid: 'org-1', name: 'Acme Inc' },
                        },
                    },
                },
            ],
        }).compile();

        useCase = module.get(DeleteTeamMembersUseCase);
    });

    it('emits with the per-recipient channel split (email to removed user, in-app to owners)', async () => {
        await useCase.execute('tm-1');

        expect(notify.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.ORG_MEMBER_REMOVED,
                organizationId: 'org-1',
                recipients: [
                    {
                        kind: 'email',
                        email: 'alex@acme.com',
                        channels: [NotificationChannel.EMAIL],
                    },
                    {
                        kind: 'role',
                        role: Role.OWNER,
                        channels: [NotificationChannel.IN_APP],
                    },
                ],
                payload: expect.objectContaining({
                    removedUser: { name: 'Alex Rivera', email: 'alex@acme.com' },
                    removedBy: 'admin@acme.com',
                    organizationName: 'Acme Inc',
                    removedAt: expect.any(String),
                }),
            }),
        );
    });

    it('skips the emit when the removed member has no email', async () => {
        teamMembers.findOne.mockResolvedValueOnce({
            ...MEMBER,
            user: { uuid: 'user-1' }, // no email
        });

        await useCase.execute('tm-1');

        expect(notify.emit).not.toHaveBeenCalled();
    });

    it('falls back to admin uuid for removedBy when admin email is missing', async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DeleteTeamMembersUseCase,
                { provide: TEAM_MEMBERS_SERVICE_TOKEN, useValue: teamMembers },
                { provide: DeleteUserUseCase, useValue: deleteUser },
                { provide: NotificationService, useValue: notify },
                {
                    provide: REQUEST,
                    useValue: {
                        user: {
                            uuid: 'admin-1',
                            organization: { uuid: 'org-1', name: 'Acme Inc' },
                        },
                    },
                },
            ],
        }).compile();
        const sansEmail = module.get(DeleteTeamMembersUseCase);

        await sansEmail.execute('tm-1');

        expect(notify.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                payload: expect.objectContaining({ removedBy: 'admin-1' }),
            }),
        );
    });

    it('does not block the delete flow if notify.emit fails', async () => {
        notify.emit.mockRejectedValueOnce(new Error('outbox down'));

        await expect(useCase.execute('tm-1')).resolves.not.toThrow();
        expect(teamMembers.deleteMembers).toHaveBeenCalled();
        // Still cascaded to user delete (single-team removal).
        expect(deleteUser.execute).toHaveBeenCalledWith('user-1');
    });
});
