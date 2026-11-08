import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '@snowluma/core/bridge';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { GroupMemberInfo, QQGroupInfo } from '@snowluma/protocol/qq-info';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
    OidbBase,
    OidbRobotUinRangeResponse,
    OidbSvcTrpcTcp0xFE7_3Response,
} from '@snowluma/proto-defs/oidb';
import type { OidbGroupMemberListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { getGroupMemberInfo, getGroupMemberList } from '../src/modules/contact-actions';

const groupId = 680;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }

    vi.restoreAllMocks();
});

function member(uin: number, card: string): GroupMemberInfo {
    return {
        uin,
        uid: `u_${uin}`,
        nickname: `old-${uin}`,
        card,
        isRobot: false,
        role: 'member',
        level: 1,
        title: '',
        joinTime: 10,
        lastSentTime: 20,
        shutUpTime: 0,
    };
}

function group(id = groupId): QQGroupInfo {
    return {
        groupId: id,
        groupName: 'test group',
        remark: '',
        memberCount: 0,
        memberMax: 100,
        members: new Map(),
    };
}

function packet(responseData: Uint8Array): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(responseData),
    };
}

async function openBridge(dbPath: string) {
    const identity = new IdentityService('10001', dbPath);
    const bridge = new Bridge(identity);
    cleanups.push(() => bridge.dispose());
    await identity.initialization;
    // Profile enrichment is independent of the roster and card decoding.
    vi.spyOn(bridge.apis.contacts, 'fetchUserProfile').mockImplementation(async (uin) => ({
        uin,
        uid: `u_${uin}`,
        nickname: 'profile',
        remark: '',
        qid: '',
        sex: 'unknown',
        age: 0,
        sign: '',
        avatar: '',
        level: 0,
        qidianMasterFlag: 0,
        qidianCrewFlag: 0,
        qidianCrewFlag2: 0,
    }));
    return bridge;
}

function sendPages(bridge: Bridge, pages: OidbSvcTrpcTcp0xFE7_3Response[]) {
    const tokens: string[] = [];
    const send = vi.spyOn(bridge, 'sendRawPacket').mockImplementation(async (command, bytes) => {
        if (command === 'OidbSvcTrpcTcp.0x496_0') {
            return packet(
                protobuf_encode<OidbBase<OidbRobotUinRangeResponse>>({
                    body: { robotConfig: { version: 1, ranges: [{ minUin: 66n, maxUin: 66n }] } },
                }),
            );
        }

        if (command !== 'OidbSvcTrpcTcp.0xfe7_3') {
            throw new Error(`unexpected command: ${command}`);
        }

        const request = protobuf_decode<OidbBase<OidbGroupMemberListRequest>>(bytes);
        expect(request.body?.groupUin).toBe(groupId);
        tokens.push(request.body?.token ?? '');
        const page = pages[tokens.length - 1];

        if (!page) {
            throw new Error('roster unavailable');
        }

        return packet(protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>({ body: page }));
    });
    return { send, tokens };
}

describe('group card failures through roster, cache and OneBot output', () => {
    it.each([false, true])(
        'returns every page and preserves valid cards with no_cache=%s',
        async (noCache) => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'group-card-'));
            cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
            const dbPath = path.join(directory, 'identity.db');
            const bridge = await openBridge(dbPath);
            bridge.identity.rememberGroups([group(), group(681)]);
            bridge.identity.rememberGroupMembers(groupId, [
                member(11, 'last valid card'),
                member(44, 'removed card'),
                member(55, ''),
            ]);
            bridge.identity.rememberGroupMembers(681, [member(22, 'another group card')]);
            const damaged = Buffer.from('616207', 'hex');
            const firstPage: OidbSvcTrpcTcp0xFE7_3Response = {
                token: 'page-2',
                members: [11, 22, 33, 44, 55].map((uin) => ({
                    uin: { uin, uid: `u_${uin}` },
                    memberName: `fresh-${uin}`,
                    permission: 2,
                    memberCard: {
                        memberCard:
                            uin === 33
                                ? Buffer.from('fresh card')
                                : uin === 44
                                  ? Buffer.alloc(0)
                                  : damaged,
                    },
                })),
            };
            const transport = sendPages(bridge, [
                firstPage,
                { members: [{ uin: { uin: 66, uid: 'u_66' } }] },
            ]);

            const output = await getGroupMemberList(bridge, groupId, noCache);
            expect(output.map((entry) => [entry.user_id, entry.card])).toEqual([
                [11, 'last valid card'],
                [22, ''],
                [33, 'fresh card'],
                [44, ''],
                [55, ''],
                [66, ''],
            ]);
            expect(output[0]).toMatchObject({ nickname: 'fresh-11', role: 'admin' });
            expect(output[5]).toMatchObject({ is_robot: true });
            expect(transport.tokens).toEqual(['', 'page-2']);
            expect(bridge.identity.findGroupMember(groupId, 22)?.card).toBeUndefined();
            expect(bridge.identity.findGroupMember(681, 22)?.card).toBe('another group card');

            expect(await getGroupMemberList(bridge, groupId)).toEqual(output);
            expect(await getGroupMemberInfo(bridge, groupId, 22)).toMatchObject({
                user_id: 22,
                card: '',
                role: 'admin',
            });
            expect(await getGroupMemberInfo(bridge, groupId, 11)).toMatchObject({
                card: 'last valid card',
            });
            expect(transport.tokens).toEqual(['', 'page-2']);
            await bridge.dispose();

            const restarted = await openBridge(dbPath);
            const offline = sendPages(restarted, []);
            expect(restarted.identity.findGroupMember(groupId, 22)?.card).toBeUndefined();
            expect(restarted.identity.findGroupMember(groupId, 55)?.card).toBe('');
            const cachedOutput = await getGroupMemberList(restarted, groupId);
            expect(cachedOutput).toHaveLength(output.length);
            expect(cachedOutput).toEqual(expect.arrayContaining(output));
            expect(offline.tokens).toEqual(['']);

            sendPages(restarted, [
                {
                    members: [
                        {
                            uin: { uin: 22, uid: 'u_22' },
                            memberName: 'recovered',
                            memberCard: { memberCard: Buffer.from('decoded card') },
                        },
                    ],
                },
            ]);
            expect(await getGroupMemberInfo(restarted, groupId, 22, true)).toMatchObject({
                nickname: 'recovered',
                card: 'decoded card',
            });
            await restarted.dispose();
            const recovered = await openBridge(dbPath);
            expect(recovered.identity.findGroupMember(groupId, 22)?.card).toBe('decoded card');
        },
    );

    it('still rejects a forced refresh when a later page fails and keeps the previous roster', async () => {
        const bridge = new Bridge(IdentityService.memory('10001'));
        cleanups.push(() => bridge.dispose());
        bridge.identity.rememberGroups([group()]);
        bridge.identity.rememberGroupMembers(groupId, [member(11, 'existing')]);
        sendPages(bridge, [
            {
                token: 'missing-page',
                members: [
                    {
                        uin: { uin: 22 },
                        memberCard: { memberCard: Buffer.from('616207', 'hex') },
                    },
                ],
            },
        ]);
        await expect(getGroupMemberList(bridge, groupId, true)).rejects.toThrow(
            'roster unavailable',
        );
        expect(bridge.identity.findGroupMember(groupId, 11)?.card).toBe('existing');
        expect(bridge.identity.findGroupMember(groupId, 22)).toBeNull();
    });
});
