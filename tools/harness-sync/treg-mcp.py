"""Expose Treg MCP through its existing local CLI login, without copying tokens."""

import asyncio
import json
import logging
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server


async def main():
    config = json.loads((Path.home() / ".treg" / "config.json").read_text())
    token = config.get("token")
    if not token:
        raise RuntimeError("Treg CLI login is missing; run treg login")
    # Fixed origin: never forward the credential to a configurable destination.
    async with streamablehttp_client(
        "https://treg.to/mcp/", headers={"Authorization": "Bearer " + token}
    ) as (reader, writer, _):
        async with ClientSession(reader, writer) as remote:
            await remote.initialize()
            server = Server("treg-cli-login")

            @server.list_tools()
            async def list_tools():
                result = await remote.list_tools()
                return result.tools

            @server.call_tool()
            async def call_tool(name, arguments):
                return await remote.call_tool(name, arguments)

            async with stdio_server() as (incoming, outgoing):
                await server.run(
                    incoming, outgoing, server.create_initialization_options()
                )


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(main())
    except Exception:
        # Transport exceptions may include request details. Never log credentials.
        raise SystemExit(
            "Treg MCP connection failed; check the local CLI login and network."
        )
