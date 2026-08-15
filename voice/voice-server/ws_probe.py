"""Dev probe — connect to ws://:3108/events and print events for N seconds.
Used to verify the wake pipeline without a HUD tab open. Not part of the server."""
import asyncio
import sys

import websockets


async def main(seconds: float):
    async with websockets.connect("ws://127.0.0.1:3108/events") as ws:
        print("connected", flush=True)
        loop = asyncio.get_running_loop()
        end = loop.time() + seconds
        while True:
            left = end - loop.time()
            if left <= 0:
                break
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=left)
                print("EVENT", msg, flush=True)
            except asyncio.TimeoutError:
                break
    print("done", flush=True)


if __name__ == "__main__":
    asyncio.run(main(float(sys.argv[1]) if len(sys.argv) > 1 else 15.0))
