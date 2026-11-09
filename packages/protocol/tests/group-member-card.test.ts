import { describe, expect, it } from 'vitest';
import { subscribeLogs } from '@snowluma/common/logger';
import type { PushMsg, RichGroupCard } from '@snowluma/proto-defs/message';
import type { OidbBase, OidbSvcTrpcTcp0xFE7_3Response } from '@snowluma/proto-defs/oidb';
import { protobuf_encode } from '@snowluma/proton';
import { IdentityService } from '../src/identity-service';
import type { GroupMemberInfo } from '../src/qq-info';
import { MSG_PUSH_CMD, parseMsgPushOrThrow } from '../src/msg-push';
import { FetchGroupMemberListPage } from '../src/oidb-services/contacts/fetch-group-member-list-page';
import { decodeGroupMemberCard, isBinaryCardText } from '../src/group-member-card';

const groupId = 42;
const uin = 123;
const hex = (s: string) => Buffer.from(s, 'hex');
const controlCodes = [
    ...Array.from({ length: 0x20 }, (_, code) => code).filter(
        (code) => ![9, 10, 13].includes(code),
    ),
    0x7f,
];

function styledCard(text: Uint8Array): Uint8Array {
    return protobuf_encode<RichGroupCard>({ parts: [{ text }] });
}

async function fetchMember(card: Uint8Array) {
    const responseData = Buffer.from(
        protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>({
            body: {
                members: [
                    { uin: { uin }, memberName: 'nickname', memberCard: { memberCard: card } },
                ],
            },
        }),
    );
    const page = await FetchGroupMemberListPage.invoke(
        {
            sendRawPacket: async () => ({
                success: true,
                gotResponse: true,
                errorCode: 0,
                errorMessage: '',
                responseData,
            }),
        },
        { groupId, token: '' },
    );
    return page.members[0]!;
}

function push(identity: IdentityService, card: Uint8Array, memberCardType?: number) {
    const body = protobuf_encode<PushMsg>({
        message: {
            responseHead: {
                fromUin: uin,
                grp: { groupUin: groupId, memberCard: card, memberCardType },
            },
            contentHead: { msgType: 82, sequence: 1 },
            body: { richText: { elems: [{ text: { str: 'hello' } }] } },
        },
    });
    return parseMsgPushOrThrow(
        {
            pid: 0,
            uin: '10001',
            serviceCmd: MSG_PUSH_CMD,
            seqId: 1,
            retCode: 0,
            fromClient: false,
            body,
        },
        identity,
    )[0];
}

function withCachedMember(member: GroupMemberInfo) {
    const identity = IdentityService.memory('10001');
    identity.rememberGroups([
        {
            groupId,
            groupName: 'group',
            remark: '',
            memberCount: 1,
            memberMax: 10,
            members: new Map(),
        },
    ]);
    identity.rememberGroupMembers(groupId, [member]);
    return identity;
}

describe('group member card wire formats', () => {
    it.each([
        // Both #646 samples, with unrelated names of the same UTF-8 byte length.
        [
            '测试昵称',
            Buffer.concat([
                hex('0a0e120c'),
                Buffer.from('测试昵称'),
                hex('0a090a0724c7bfc4801a100a090a0724c7bfc4801a111000'),
            ]),
        ],
        [
            '三字名',
            Buffer.concat([
                hex('0a0b1209'),
                Buffer.from('三字名'),
                hex('0a090a0724c3bfc48011221000'),
            ]),
        ],
        // Reordered outer fields, multiple text parts and a control part containing a text field.
        ['甲乙', hex('10000a051203e794b20a080a01ff1203e581870a070a001203e581870a051203e4b999')],
        ['🌙', hex('0a041202f09f0a0412028c99')], // A UTF-8 code point split between text parts.
        // #680: QQ hides the 0x14 embedded in the text part and shows "  ƕ".
        ['  ƕ', hex('0a090a0724c7bfc480440e0a071205202014c6951000')],
        [' 普通🌙 ', Buffer.from(' 普通🌙 ')],
    ] as const)(
        'decodes %s in the roster and in pushes with or without a cached member',
        async (name, card) => {
            const member = await fetchMember(card);
            expect(member.card).toBe(name);
            const identity = IdentityService.memory('10001');
            expect(push(identity, card)).toMatchObject({ senderNick: name, senderCard: '' });
            const cached = withCachedMember({ ...member, card: 'outdated' });
            expect(push(cached, card)).toMatchObject({
                senderNick: 'nickname',
                senderCard: name,
            });
        },
    );

    it.each(controlCodes.map((code) => [code.toString(16).padStart(2, '0'), code] as const))(
        'cleans 0x%s only in decoded card text and keeps raw text strict',
        async (_label, code) => {
            const raw = Buffer.from(` 甲${String.fromCodePoint(code)}乙🌙 `);
            const card = styledCard(raw);
            const member = await fetchMember(card);
            expect(member.card).toBe(' 甲乙🌙 ');
            expect(push(withCachedMember({ ...member, card: 'outdated' }), card)).toMatchObject({
                senderNick: 'nickname',
                senderCard: ' 甲乙🌙 ',
            });
            expect(() => decodeGroupMemberCard(raw)).toThrow('control characters');
            // Detection also serves repeated cache reads; it must not depend on regex state.
            expect(isBinaryCardText(raw.toString())).toBe(true);
            expect(isBinaryCardText(raw.toString())).toBe(true);
            expect(isBinaryCardText(member.card!)).toBe(false);
        },
    );

    it('preserves whitespace, Unicode formatting and combining characters', async () => {
        const text = ' \t甲\n乙\r 👩\u200d💻 ❤️\u200b\u2060 e\u0301 \u0085 ';
        const member = await fetchMember(styledCard(Buffer.from(text)));
        expect(member.card).toBe(text);
        expect(decodeGroupMemberCard(Buffer.from(text))).toBe(text);
        expect(isBinaryCardText(text)).toBe(false);
    });

    it('treats decoded text containing only non-display controls as an empty card', async () => {
        const card = styledCard(Buffer.from(controlCodes));
        const member = await fetchMember(card);
        expect(member.card).toBe('');
        expect(push(withCachedMember({ ...member, card: 'outdated' }), card)).toMatchObject({
            senderNick: 'nickname',
            senderCard: '',
        });
    });

    it('treats a control-only card as empty even when a previous card was cached', async () => {
        const control = hex('0a030a01ff1000');
        const member = await fetchMember(control);
        expect(member.card).toBe('');
        expect(push(withCachedMember({ ...member, card: 'outdated' }), control)).toMatchObject({
            senderNick: 'nickname',
            senderCard: '',
        });
    });

    it('keeps explicitly literal nicknames separate from the cached group card', async () => {
        const literal = '\n\t!abcdefgh'; // also a valid envelope containing an unknown fixed64 field
        const identity = withCachedMember(await fetchMember(Buffer.from('existing card')));
        expect(push(identity, Buffer.from(literal), 2)).toMatchObject({
            senderNick: literal,
            senderCard: 'existing card',
        });
    });

    it.each(['0a051202ff00', '616207', '0a031201ff', '0a0512036114ff'])(
        'keeps a member with unreadable card %s and logs its context',
        async (encoded) => {
            const damaged = hex(encoded);
            const warnings: string[] = [];
            const unsubscribe = subscribeLogs((entry) => {
                if (entry.level === 'warn') {
                    warnings.push(entry.message);
                }
            });

            try {
                expect(() => decodeGroupMemberCard(damaged)).toThrow('group card');
                expect(await fetchMember(damaged)).toMatchObject({
                    uin,
                    nickname: 'nickname',
                    card: undefined,
                });
                expect(warnings).toEqual([
                    expect.stringMatching(
                        new RegExp(`group=42 member=123 bytes=${damaged.length} reason=group card`),
                    ),
                ]);
                expect(warnings[0]).not.toContain(encoded);
                expect(warnings[0]).not.toContain('nickname');
            } finally {
                unsubscribe();
            }
        },
    );

    it('still delivers a message with damaged metadata', async () => {
        const damaged = hex('0a051202ff00');
        const identity = withCachedMember(await fetchMember(Buffer.from('existing card')));
        expect(push(identity, damaged)).toMatchObject({
            senderNick: 'nickname',
            senderCard: 'existing card',
            elements: [{ type: 'text', text: 'hello' }],
        });
    });

    it('keeps literal display names strict when they contain a styled-card control character', async () => {
        const identity = withCachedMember(await fetchMember(Buffer.from('existing card')));
        expect(push(identity, Buffer.from('literal\x14name'), 2)).toMatchObject({
            senderNick: 'nickname',
            senderCard: 'existing card',
            elements: [{ type: 'text', text: 'hello' }],
        });
    });
});
