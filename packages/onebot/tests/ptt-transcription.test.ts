import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { pb, uint_32 } from '@snowluma/proton';
import type { MsgInfo } from '@snowluma/proto-defs/element';
import type { MessageBody } from '@snowluma/proto-defs/message';
import type { PttTransReq, PttTransResp } from '@snowluma/proto-defs/ptt-trans';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ExtrasApi } from '../../core/src/bridge/apis/extras';
import { decodeRichBody } from '@snowluma/protocol/msg-push/rich-body-decoder';
import { elementsToOneBotSegments, type ConverterContext } from '../src/event-converter';
import { MediaIndexer } from '../src/media-indexer';
import { MediaStore } from '../src/media-store';
import { migrateLegacyMedia } from '../src/media-store-migration';
import { MessageStore } from '../src/message-store';
import { fetchPttText } from '../src/modules/media-actions';

// Decode the routing fields independently of the production request schema.
interface TranscriptionRouting {
    isNtv2?: pb<5, uint_32>;
    storeRegion?: pb<6, uint_32>;
}

const selfId = 10001;
const peerId = 20002;
const groupId = 30003;
const messageId = -607;
const md5 = '00112233445566778899aabbccddeeff';
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

function location() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-transcription-'));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    return {
        dbPath: path.join(directory, 'messages.db'),
        legacyPath: path.join(directory, 'media.db'),
    };
}

async function openStores(dbPath: string) {
    const messages = new MessageStore(dbPath);
    await messages.initialization;
    const media = new MediaStore(dbPath, 1);
    let closed = false;

    const close = async () => {
        if (closed) {
            return;
        }

        closed = true;
        await media.close();
        await messages.close();
    };

    cleanups.push(close);
    await media.initialization;
    const indexer = new MediaIndexer(media);
    const converter: ConverterContext = {
        selfId,
        imageUrlResolver: null,
        mediaUrlResolver: null,
        messageIdResolver: null,
        mediaSegmentSink: (...args) => indexer.remember(...args),
    };
    return { messages, media, converter, close };
}

function voice(isGroup: boolean, ntv2: boolean, storeId?: number) {
    const body: MessageBody = {
        richText: ntv2
            ? {
                  elems: [
                      {
                          commonElem: {
                              serviceType: 48,
                              businessType: isGroup ? 12 : 22,
                              pbElem: protobuf_encode<MsgInfo>({
                                  msgInfoBody: [
                                      {
                                          index: {
                                              fileUuid: 'voice-resource',
                                              storeId,
                                              info: {
                                                  fileName: 'voice.silk',
                                                  fileSize: 4003,
                                                  fileHash: md5,
                                                  time: 2,
                                                  type: { type: 3, voiceFormat: 1 },
                                              },
                                          },
                                      },
                                  ],
                              }),
                          },
                      },
                  ],
              }
            : {
                  ptt: {
                      fileName: 'voice.silk',
                      fileUuid: Buffer.from('voice-resource'),
                      fileMd5: Buffer.from(md5, 'hex'),
                      fileSize: 4003,
                      time: 2,
                      format: 1,
                  },
              },
    };
    const elements = decodeRichBody(
        protobuf_decode<MessageBody>(protobuf_encode<MessageBody>(body)),
        isGroup,
    );
    expect(elements).toHaveLength(1);
    return elements;
}

async function saveVoice(
    stores: Awaited<ReturnType<typeof openStores>>,
    isGroup: boolean,
    elements: ReturnType<typeof voice>,
    withSnapshot = true,
) {
    const segments = await elementsToOneBotSegments(
        stores.converter,
        elements,
        isGroup,
        isGroup ? groupId : peerId,
    );
    await stores.messages.storeEvent(
        messageId,
        isGroup,
        isGroup ? groupId : peerId,
        42,
        isGroup ? 'GroupMessage' : 'PrivateMessage',
        {
            message_id: messageId,
            message_type: isGroup ? 'group' : 'private',
            user_id: peerId,
            ...(isGroup ? { group_id: groupId } : {}),
            message: withSnapshot ? segments : JSON.parse(JSON.stringify(segments)),
        },
    );
}

function transport(isGroup: boolean, errCode = 0) {
    const sendRawPacket = vi.fn(async (_cmd: string, _bytes: Uint8Array) => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: protobuf_encode<PttTransResp>(
            isGroup
                ? { type: 1, groupResult: { errCode, text: errCode ? '' : '测试转写结果' } }
                : { type: 2, c2cResult: { errCode, text: errCode ? '' : '测试转写结果' } },
        ),
    }));
    const extras = new ExtrasApi({ sendRawPacket } as unknown as ConstructorParameters<
        typeof ExtrasApi
    >[0]);
    const bridge = { apis: { extras } } as unknown as BridgeInterface;
    return { sendRawPacket, bridge };
}

async function checkRequest(
    stores: Awaited<ReturnType<typeof openStores>>,
    isGroup: boolean,
    ntv2: boolean,
    storeRegion = 0,
) {
    const { sendRawPacket, bridge } = transport(isGroup);
    await expect(
        fetchPttText(stores.messages, stores.media, bridge, selfId, messageId),
    ).resolves.toEqual({ text: '测试转写结果' });
    expect(sendRawPacket).toHaveBeenCalledTimes(1);
    const [cmd, bytes] = sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe(isGroup ? 'pttTrans.TransGroupPttReq' : 'pttTrans.TransC2CPttReq');
    const routing = protobuf_decode<TranscriptionRouting>(bytes);
    expect(routing.isNtv2 ?? 0).toBe(ntv2 ? 1 : 0);
    expect(routing.storeRegion ?? 0).toBe(storeRegion);
    const request = protobuf_decode<PttTransReq>(bytes);
    expect(isGroup ? request.groupItem : request.c2cItem).toMatchObject({
        msgId: BigInt.asUintN(64, BigInt(messageId)),
        senderUin: BigInt(peerId),
        uuid: 'voice-resource',
        md5,
        duration: 2,
        size: 4003,
        format: 1,
        ...(isGroup ? { groupUin: BigInt(groupId) } : { receiverUin: BigInt(selfId) }),
    });
}

describe.each([false, true])('voice transcription (isGroup=%s)', (isGroup) => {
    it.each([
        { name: 'NT voice', ntv2: true, storeId: 1 },
        { name: 'NT voice in region zero', ntv2: true, storeId: 0 },
        { name: 'NT voice without a region', ntv2: true, storeId: undefined },
        { name: 'legacy voice', ntv2: false, storeId: undefined },
    ])('preserves $name routing through storage and reopening', async ({ ntv2, storeId }) => {
        const { dbPath } = location();
        let stores = await openStores(dbPath);
        await saveVoice(stores, isGroup, voice(isGroup, ntv2, storeId));
        await checkRequest(stores, isGroup, ntv2, storeId);
        await stores.close();
        stores = await openStores(dbPath);
        await checkRequest(stores, isGroup, ntv2, storeId);
        expect((await stores.messages.findMedia(messageId))?.[0]).toMatchObject({ isNtv2: ntv2 });
        expect(await stores.media.findRecord('voice.silk')).toMatchObject({ isNtv2: ntv2 });
        const event = await stores.messages.findEvent(messageId);
        expect(event?.message_id).toBe(messageId);
        expect(JSON.stringify(event)).not.toMatch(/isNtv2|storeId|storeRegion/);
    });

    it.each([true, false])('reads pre-marker snapshots (ntv2=%s)', async (ntv2) => {
        const { dbPath } = location();
        let stores = await openStores(dbPath);
        const elements = voice(isGroup, ntv2, ntv2 ? 1 : undefined);
        Reflect.deleteProperty(elements[0]!, 'isNtv2');
        await saveVoice(stores, isGroup, elements);
        await stores.close();
        stores = await openStores(dbPath);
        await checkRequest(stores, isGroup, ntv2, ntv2 ? 1 : 0);
    });

    it('recognizes pre-marker NT snapshots with a null default region', async () => {
        const { dbPath } = location();
        let stores = await openStores(dbPath);
        const elements = voice(isGroup, true);
        Reflect.deleteProperty(elements[0]!, 'isNtv2');
        Reflect.set(elements[0]!.mediaNode!, 'storeId', null);
        await saveVoice(stores, isGroup, elements);
        await stores.close();
        stores = await openStores(dbPath);
        await checkRequest(stores, isGroup, true);
    });

    it('retains an explicit zero region when updating the same voice', async () => {
        const { dbPath } = location();
        let stores = await openStores(dbPath);
        await saveVoice(stores, isGroup, voice(isGroup, true, 1));
        await saveVoice(stores, isGroup, voice(isGroup, true, 0));
        await stores.close();
        stores = await openStores(dbPath);
        await checkRequest(stores, isGroup, true, 0);
    });

    it.each([true, false])(
        'reads migrated media without a message snapshot (ntv2=%s)',
        async (ntv2) => {
            const { dbPath, legacyPath } = location();
            const old = await openStores(legacyPath);
            const elements = voice(isGroup, ntv2, ntv2 ? 1 : undefined);
            Reflect.deleteProperty(elements[0]!, 'isNtv2');
            await saveVoice(old, isGroup, elements);
            await old.close();
            let stores = await openStores(dbPath);
            await saveVoice(stores, isGroup, elements, false);
            await stores.close();
            await migrateLegacyMedia(dbPath);
            stores = await openStores(dbPath);
            // A same-named current entry must not replace the migrated source.
            await elementsToOneBotSegments(
                stores.converter,
                voice(isGroup, true, 9),
                isGroup,
                peerId,
            );
            expect(await stores.messages.findMedia(messageId)).toBeNull();
            await checkRequest(stores, isGroup, ntv2, ntv2 ? 1 : 0);
        },
    );

    it('preserves the server failure without retrying', async () => {
        const { dbPath } = location();
        const stores = await openStores(dbPath);
        await saveVoice(stores, isGroup, voice(isGroup, true, 1));
        const { sendRawPacket, bridge } = transport(isGroup, 9);
        await expect(
            fetchPttText(stores.messages, stores.media, bridge, selfId, messageId),
        ).rejects.toThrow('ptt translate failed: error=9');
        expect(sendRawPacket).toHaveBeenCalledTimes(1);
    });
});
