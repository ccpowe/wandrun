"""Real SSH streaming, publication, authorized uploads, and offline gateway delivery."""

import asyncio
import base64
import hashlib
import json
import os
import shlex
import subprocess
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import asyncssh
import httpx

from test_environments import _LoopbackServer
from test_gateway import gateway_manager, open_store
from test_gateway_attachment_previews import image_bytes
from wandrun.gateway.attachment_previews import AttachmentPreviewService
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.integrations import file_transfer
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.integrations.ssh_backend import SSHBackend
from wandrun.runtime.communication.messages import AgentOutput, SendMessage
from wandrun.runtime.execution.file_tools import attachment_tools
from wandrun.runtime.execution.files import TaskFiles


@asynccontextmanager
async def remote_backend(
    root: Path, *, cleanup_gate: asyncio.Event | None = None,
    drop_upload_ack: bool = False, drop_publication_receipt: bool = False,
    observed: asyncio.Event | None = None,
    publication_gate: asyncio.Event | None = None,
):
    """Execute production SSH commands on a private authenticated loopback server.

    No provider API, external host, credentials, browser, or model is used. The
    server executes the actual gateway-supplied scripts and real filesystem I/O.
    """
    children = []
    fault_tasks = []

    def upload_arguments(command):
        arguments = shlex.split(command)
        return arguments if len(arguments) > 5 and arguments[4] == file_transfer._UPLOAD else None

    async def upload_output(reader, writer):
        while line := await reader.readline():
            if drop_publication_receipt and "path" in json.loads(line):
                if observed is not None:
                    observed.set()
                continue
            if publication_gate is not None and "path" in json.loads(line):
                if observed is not None:
                    observed.set()
                await publication_gate.wait()
            if cleanup_gate is not None and "cleanup" in json.loads(line):
                if observed is not None:
                    observed.set()
                await cleanup_gate.wait()
            writer.write(line)
            await writer.drain()

    async def pump(reader, writer, *, eof=False):
        try:
            while chunk := await reader.read(65536):
                writer.write(chunk)
                await writer.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if eof:
                try:
                    writer.write_eof()
                except (BrokenPipeError, ConnectionResetError):
                    pass

    async def execute(process):
        child = await asyncio.create_subprocess_shell(
            process.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        children.append(child)
        incoming = asyncio.create_task(pump(process.stdin, child.stdin, eof=True))
        stdout = upload_output if upload_arguments(process.command) is not None else pump
        outgoing = [asyncio.create_task(stdout(child.stdout, process.stdout)),
                    asyncio.create_task(pump(child.stderr, process.stderr))]
        try:
            result = await child.wait()
            await asyncio.gather(*outgoing)
            process.exit(result)
        finally:
            incoming.cancel()
            await asyncio.gather(incoming, return_exceptions=True)
            if child.returncode is None:
                child.terminate()
                await child.wait()

    key = asyncssh.generate_private_key('ssh-ed25519')
    listener = await asyncssh.listen(
        '127.0.0.1', 0, server_factory=lambda: _LoopbackServer(key.export_public_key()),
        server_host_keys=[asyncssh.generate_private_key('ssh-ed25519')],
        sftp_factory=asyncssh.SFTPServer, process_factory=execute, encoding=None,
    )
    connection = await asyncssh.connect(
        '127.0.0.1', port=listener.get_port(), username='test', known_hosts=None,
        client_keys=[key], agent_path=None, config=None,
    )
    owner = InstaboxBackend('m_' + 'a' * 26, workdir=str(root), termination_grace=0.2)
    owner._connection = connection
    owner._connections.append(connection)
    patcher = None
    if drop_upload_ack:
        report_response = asyncssh.SSHServerChannel._report_response

        async def start_before_ack(channel, command, arguments):
            try:
                child = await asyncio.create_subprocess_shell(
                    command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                children.append(child)
                stage = Path(arguments[5]) / arguments[-1]
                async with asyncio.timeout(5):
                    while not stage.exists():
                        await asyncio.sleep(0.001)
                if observed is not None:
                    observed.set()
            finally:
                # Real exec side effects exist, but the channel never carries
                # a success/failure ACK or the script's eventual cleanup reply.
                channel.close()

        def close_before_response(channel, result):
            request = channel._request_queue[0][0]
            command = channel.get_command()
            arguments = upload_arguments(command) if request == "exec" and command else None
            if result and arguments is not None:
                fault_tasks.append(asyncio.create_task(start_before_ack(channel, command, arguments)))
            else:
                report_response(channel, result)

        patcher = patch.object(asyncssh.SSHServerChannel, "_report_response", close_before_response)
        patcher.start()
    try:
        backend = await SSHBackend.start(
            connection, label=owner.id, workdir=str(root), timeout=15, termination_grace=0.2,
        )
        owner._backend = backend
        owner._sessions.append(backend)
        owner._ever_connected = True
        yield owner
    finally:
        try:
            await owner.aclose()
        finally:
            if patcher is not None:
                patcher.stop()
            connection.close()
            await connection.wait_closed()
            listener.close()
            await listener.wait_closed()
            await asyncio.gather(*fault_tasks)
            for child in children:
                if child.returncode is None:
                    child.stdin.close()
                    try:
                        async with asyncio.timeout(5):
                            await child.wait()
                    except TimeoutError:
                        child.terminate()
                        await child.wait()


class StreamingDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.workspace = self.base / 'gateway'
        self.workspace.mkdir()
        self.remote = self.base / 'sandbox'
        self.store = open_store(self, self.workspace / 'gateway.sqlite')
        self.gateway = Gateway(self.store)
        self.gateway.workspace_root = self.workspace
        self.addCleanup(self.gateway.end_streams)
        self.worker_next = 'wait'

        async def run(prompts, task_id):
            return AgentOutput(messages=[], next=self.worker_next)

        self.manager = gateway_manager(
            self.gateway, run,
            attachment_resolver=lambda *args: self.files.resolve_attachments(*args),
            attachment_preflight=lambda sender, target, paths, task: self.files.prepare_attachments(sender, target, paths, task),
        )
        self.addAsyncCleanup(self.manager.close)
        self.conversation = self.gateway.create_conversation('Remote output', 'main', client_id=uuid4().hex)[0]['id']
        self.gateway.send_message(self.conversation, 'start', 'begin')
        await self.manager.wait(self.conversation)
        self.files = TaskFiles(
            self.workspace, self.manager, {'main': ('sandbox-machine', str(self.remote))},
            conversation_workdirs=True,
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, 'test')),
            base_url='http://gateway', headers={'Authorization': 'Bearer test'},
        )
        self.addAsyncCleanup(self.client.aclose)

    def use(self, backend):
        self.files.update_environments(
            {'main': ('sandbox-machine', str(self.remote))}, {'main': backend},
        )

    async def deliver(self, paths, text='Attached'):
        output = AgentOutput(messages=[SendMessage(
            to='human', task_id=None, message=text, attachments=paths,
        )], next='wait')
        prepared = await self.manager.prepare_attachments(output, self.conversation)
        return self.manager.dispatch(output, self.conversation, prepared=prepared)[0]

    def last_message(self):
        return next(event for event in reversed(self.store.history(self.conversation))
                    if event.type == 'message.agent')

    async def test_remote_image_remains_downloadable_and_previewable_after_disconnect(self):
        async with remote_backend(self.remote) as backend:
            self.use(backend)
            image = self.remote / 'photo.png'
            content = image_bytes(64, 32)
            image.write_bytes(content)
            receipt = await self.deliver([str(image)])
            self.assertTrue(receipt['accepted'])
            self.assertTrue(receipt['attachments'][0]['accepted'])
            record, = self.last_message().data['attachments']
            self.assertIsNone(record['remote_environment'])
            copied = Path(self.store.file(record['id'])[1])
            self.assertNotEqual(copied, image)
            image.unlink()
        previews = AttachmentPreviewService(self.workspace / '.wandrun/state/previews')
        self.gateway.attachment_previews = previews
        self.addAsyncCleanup(previews.aclose)
        self.assertEqual((await self.client.get(f"/files/{record['id']}/content")).content, content)
        preview = await self.client.get(f"/files/{record['id']}/preview")
        self.assertEqual(preview.status_code, 200)
        self.assertEqual((preview.json()['width'], preview.json()['height']), (64, 32))

    async def test_replay_reuses_snapshot_but_changed_source_gets_distinct_copy_and_file(self):
        async with remote_backend(self.remote) as backend:
            self.use(backend)
            source = self.remote / 'report.txt'
            source.write_bytes(b'first')
            await self.deliver([str(source)])
            first, = self.last_message().data['attachments']
            await self.deliver([str(source)])
            again, = self.last_message().data['attachments']
            self.assertEqual(first['id'], again['id'])
            source.write_bytes(b'second')
            await self.deliver([str(source)])
            second, = self.last_message().data['attachments']
            self.assertNotEqual(first['id'], second['id'])
            self.assertEqual((await self.client.get(f"/files/{first['id']}/content")).content, b'first')
            self.assertEqual((await self.client.get(f"/files/{second['id']}/content")).content, b'second')

    async def test_bad_paths_have_individual_receipts_without_losing_text_or_valid_file(self):
        async with remote_backend(self.remote) as backend:
            self.use(backend)
            good = self.remote / 'good.txt'
            good.write_bytes(b'allowed')
            outside = self.base / 'private.txt'
            outside.write_bytes(b'not allowed')
            (self.remote / 'alias.txt').symlink_to(good)
            (self.remote / 'linked').symlink_to(self.base, target_is_directory=True)
            (self.remote / '.wandrun/secret').write_bytes(b'control')
            os.mkfifo(self.remote / 'pipe')
            (self.remote / '.wandrun').rename(self.remote / 'control-dir')
            (self.remote / '.wandrun').symlink_to(self.remote / 'control-dir', target_is_directory=True)
            bad = [str(outside), str(self.remote / '../private.txt'), str(self.remote / 'alias.txt'),
                   str(self.remote / 'linked/private.txt'), str(self.remote / '.wandrun/secret'),
                   str(self.remote / 'control-dir/secret'), str(self.remote / 'pipe'),
                   str(self.remote / 'missing'), str(self.remote)]
            receipt = await self.deliver([*bad, str(good)], 'Text survives')
            self.assertTrue(receipt['accepted'])
            self.assertEqual([item['accepted'] for item in receipt['attachments']], [False] * len(bad) + [True])
            self.assertEqual(self.last_message().data['text'], 'Text survives')
            self.assertEqual(len(self.last_message().data['attachments']), 1)

    def large_file(self):
        source = self.remote / 'large.bin'
        with source.open('wb') as stream:
            for _ in range(128):
                stream.write(b'x' * (256 * 1024))
        return source

    async def test_large_file_stream_and_source_change_do_not_publish_corruption(self):
        async with remote_backend(self.remote) as backend:
            self.use(backend)
            source = self.large_file()
            receipt = await self.deliver([str(source)])
            self.assertTrue(receipt['attachments'][0]['accepted'])
            record, = self.last_message().data['attachments']
            self.assertEqual(record['size'], 32 * 1024 * 1024)
            copied = Path(self.store.file(record['id'])[1])
            with source.open('rb') as left, copied.open('rb') as right:
                self.assertEqual(hashlib.file_digest(left, 'sha256').digest(), hashlib.file_digest(right, 'sha256').digest())
            changed = False
            write = file_transfer._write

            def change_during_copy(descriptor, chunk):
                nonlocal changed
                write(descriptor, chunk)
                if not changed:
                    changed = True
                    with source.open('r+b') as stream:
                        stream.seek(16 * 1024 * 1024)
                        stream.write(b'y')

            with patch.object(file_transfer, '_write', change_during_copy):
                receipt = await self.deliver([str(source)])
            self.assertTrue(changed)
            self.assertFalse(receipt['attachments'][0]['accepted'])
            self.assertEqual(self.last_message().data['attachments'], [])
            self.assertEqual(list(copied.parent.parent.glob('*/large.bin')), [copied])

    async def test_cancelled_copy_has_no_published_partial_and_session_remains_usable(self):
        async with remote_backend(self.remote) as backend:
            self.use(backend)
            source = self.large_file()
            write = file_transfer._write
            cancelled = False

            def cancel_during_copy(descriptor, chunk):
                nonlocal cancelled
                write(descriptor, chunk)
                if not cancelled:
                    cancelled = True
                    asyncio.current_task().cancel()

            with patch.object(file_transfer, '_write', cancel_during_copy):
                copying = asyncio.create_task(
                    self.files.prepare_attachments(self.conversation, 'human', [str(source)]),
                )
                with self.assertRaises(asyncio.CancelledError):
                    await copying
            self.assertEqual(list(self.workspace.rglob('large.bin')), [])
            self.assertEqual(list(self.workspace.rglob('*.stage')), [])
            self.assertEqual((await backend.aexecute('printf usable')).exit_code, 0)

    async def test_upload_authorization_fetch_replay_and_execution(self):
        self.gateway.enable_uploads()
        metadata = {
            'conversation_id': self.conversation, 'filename': 'input.txt', 'filetype': 'text/plain',
        }
        created = await self.client.post('/uploads', headers={
            'Tus-Resumable': '1.0.0', 'Upload-Length': '3',
            'Upload-Metadata': ','.join(
                key + ' ' + base64.b64encode(value.encode()).decode()
                for key, value in metadata.items()
            ),
        })
        self.assertEqual(created.status_code, 201)
        completed = await self.client.patch(created.headers['Location'], content=b'abc', headers={
            'Tus-Resumable': '1.0.0', 'Upload-Offset': '0',
            'Content-Type': 'application/offset+octet-stream',
        })
        self.assertEqual(completed.status_code, 204)
        identity = completed.headers['Upload-File-Id']
        self.assertFalse(self.remote.exists())
        self.files.bind_upload_resolver(
            lambda task, file_id: self.store.user_uploads(self.manager.root_of(task), [file_id])[0],
        )
        fetch, = attachment_tools(self.files)
        config = {'configurable': {'thread_id': self.conversation}}
        async with remote_backend(self.remote) as backend:
            self.use(backend)
            result = await fetch.ainvoke({'upload_id': identity}, config=config)
            self.assertNotIn('error', result)
            execution = await backend.aexecute('cat ' + shlex.quote(result['path']))
            self.assertEqual(execution.exit_code, 0)
            self.assertIn('abc', execution.output)
            repeated = await fetch.ainvoke({'upload_id': identity}, config=config)
            self.assertEqual(result, repeated)
            other = self.store.create_conversation('Other', 'main', client_id=uuid4().hex)[0]['id']
            other_upload = self.gateway.uploads.create(other, 'main', 'other.txt', 'text/plain', 0, '')
            for unauthorized in (other_upload['file_id'], 'm_' + 'a' * 26, 'https://invalid/file', str(self.workspace / 'gateway.sqlite')):
                rejected = await fetch.ainvoke({'upload_id': unauthorized}, config=config)
                self.assertIn('error', rejected)
            self.assertEqual(list(self.remote.rglob('other.txt')), [])
            # An existing destination is never silently overwritten on replay.
            Path(result['path']).write_bytes(b'changed')
            conflict = await fetch.ainvoke({'upload_id': identity}, config=config)
            self.assertIn('error', conflict)
            self.assertEqual(Path(result['path']).read_bytes(), b'changed')
            self.assertEqual(backend.pending_transfer_owners(), set())
            self.assertEqual(self.files.pending_transfer_agents(), set())
            self.assertEqual(list(self.remote.rglob("*.stage")), [])

    async def test_cancelled_upload_never_exposes_partial_target(self):
        self.gateway.enable_uploads()
        size = 8 * 1024 * 1024
        upload = self.gateway.uploads.create(self.conversation, 'main', 'cancel.bin', 'application/octet-stream', size, '')

        async def body():
            for _ in range(8):
                yield b'x' * (1024 * 1024)

        completed = await self.gateway.uploads.advance(upload, 0, body())
        self.files.bind_upload_resolver(
            lambda task, file_id: self.store.user_uploads(self.manager.root_of(task), [file_id])[0],
        )
        async with remote_backend(self.remote) as backend:
            self.use(backend)
            read = os.read
            interrupted = False

            def cancel_source_read(descriptor, count):
                nonlocal interrupted
                chunk = read(descriptor, count)
                if not interrupted and count == file_transfer.CHUNK_SIZE:
                    interrupted = True
                    asyncio.current_task().cancel()
                return chunk

            with patch.object(file_transfer.os, 'read', cancel_source_read):
                copying = asyncio.create_task(
                    self.files.fetch_upload(self.conversation, completed['file_id']),
                )
                with self.assertRaises(asyncio.CancelledError):
                    await copying
            self.assertTrue(interrupted)
            self.assertEqual(list(self.remote.rglob('cancel.bin')), [])
            self.assertEqual(list(self.remote.rglob('*.stage')), [])
            result = await self.files.fetch_upload(self.conversation, completed['file_id'])
            self.assertEqual(Path(result['path']).stat().st_size, size)

    async def registered_upload(self, name='input.txt'):
        self.gateway.enable_uploads()
        upload = self.gateway.uploads.create(self.conversation, 'main', name, 'text/plain', 3, '')

        async def body():
            yield b'abc'

        completed = await self.gateway.uploads.advance(upload, 0, body())
        self.files.bind_upload_resolver(
            lambda task, file_id: self.store.user_uploads(self.manager.root_of(task), [file_id])[0],
        )
        return completed['file_id']

    async def finish_worker(self):
        self.worker_next = 'done'
        self.manager.interrupt('Finish this turn', self.conversation, agent_name='main')
        await self.manager.wait(self.conversation)
        self.assertEqual(self.manager.get(self.conversation)['status'], 'completed')
        self.assertEqual(self.manager.running_tasks('main'), [])

    async def test_done_worker_retains_transfer_owner_until_real_delayed_cleanup_ack(self):
        identity = await self.registered_upload()
        gate, observed = asyncio.Event(), asyncio.Event()
        async with remote_backend(self.remote, cleanup_gate=gate, observed=observed) as backend:
            self.use(backend)
            fetch, = attachment_tools(self.files)
            try:
                with patch.object(file_transfer, 'TRANSFER_CLEANUP_LIMIT', 0.01):
                    result = await fetch.ainvoke(
                        {'upload_id': identity}, config={'configurable': {'thread_id': self.conversation}},
                    )
                self.assertIn('error', result)
                await asyncio.wait_for(observed.wait(), 5)
                await self.finish_worker()
                self.assertEqual(backend.processes.pending_owners(), set())
                self.assertEqual(backend.pending_transfer_owners(), {self.conversation})
                self.assertNotIn(None, backend.pending_transfer_owners())
                self.assertTrue(backend._backend._transfers)
                # Deliver the actual remote script's retained cleanup response.
                gate.set()
                async with asyncio.timeout(5):
                    while backend.pending_transfer_owners():
                        await asyncio.sleep(0.001)
                self.assertEqual(backend._backend._unconfirmed, {})
                self.assertEqual(list(self.remote.rglob('*.stage')), [])
                imported = await self.files.fetch_upload(self.conversation, identity)
                self.assertEqual(Path(imported['path']).read_bytes(), b'abc')
            finally:
                gate.set()

    async def test_exec_accepted_but_ack_lost_retains_owner_and_exact_stage_after_done(self):
        identity = await self.registered_upload()
        observed = asyncio.Event()
        with self.assertRaises(CleanupUnconfirmedError) as closing:
            async with remote_backend(self.remote, drop_upload_ack=True, observed=observed) as backend:
                self.use(backend)
                fetch, = attachment_tools(self.files)
                result = await asyncio.wait_for(fetch.ainvoke(
                    {'upload_id': identity}, config={'configurable': {'thread_id': self.conversation}},
                ), 5)
                self.assertIn('error', result)
                await asyncio.wait_for(observed.wait(), 5)
                stage, = self.remote.rglob('.wandrun-*.stage')
                self.assertIn(str(stage), ' '.join(backend._backend._unconfirmed.values()))
                self.assertFalse(backend._backend._transfers)
                await self.finish_worker()
                self.assertEqual(backend.pending_transfer_owners(), {self.conversation})
                self.assertEqual(list(self.remote.rglob('uploads/*/*/input.txt')), [])
        self.assertIn(str(stage), str(closing.exception))
        # Fixture teardown can observe the server's eventual cleanup, but that
        # is not an acknowledgement received by the disconnected gateway.
        self.assertEqual(backend.pending_transfer_owners(), {self.conversation})
