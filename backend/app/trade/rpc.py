import httpx
from solders.pubkey import Pubkey

TOKEN_PROGRAM = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ATA_PROGRAM = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")


class RpcError(Exception):
    pass


async def rpc(http: httpx.AsyncClient, url: str, method: str, params: list):
    resp = await http.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise RpcError(f"{method}: {body['error']}")
    return body["result"]


def associated_token_address(wallet: str, mint: str, token_program: Pubkey = TOKEN_PROGRAM) -> str:
    address, _ = Pubkey.find_program_address(
        [bytes(Pubkey.from_string(wallet)), bytes(token_program), bytes(Pubkey.from_string(mint))], ATA_PROGRAM
    )
    return str(address)


def token_amount(account: dict | None) -> int:
    """Raw token amount from a jsonParsed token account; a missing account holds zero."""
    if not account:
        return 0
    try:
        return int(account["data"]["parsed"]["info"]["tokenAmount"]["amount"])
    except (KeyError, TypeError, ValueError):
        return 0


async def mint_token_program(http: httpx.AsyncClient, url: str, mint: str) -> Pubkey:
    """Outcome mints may live under Token-2022, which changes the ATA derivation."""
    result = await rpc(http, url, "getAccountInfo", [mint, {"encoding": "base64"}])
    if not result.get("value"):
        raise RpcError(f"mint {mint} not found")
    return Pubkey.from_string(result["value"]["owner"])


async def token_balances(http: httpx.AsyncClient, url: str, addresses: list[str]) -> list[int]:
    result = await rpc(http, url, "getMultipleAccounts", [addresses, {"encoding": "jsonParsed"}])
    return [token_amount(account) for account in result["value"]]
