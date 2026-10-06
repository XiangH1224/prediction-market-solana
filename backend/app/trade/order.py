import httpx
from pydantic import BaseModel

from ..config import TOKEN_SCALE, USDC_MINT, Settings


class OrderError(Exception):
    pass


class Order(BaseModel):
    tx_base64: str
    in_amount: int
    out_amount: int
    min_out_amount: int
    execution_mode: str = ""
    compute_unit_limit: int | None = None
    last_valid_block_height: int | None = None

    @property
    def effective_price(self) -> float:
        """Dollars paid per contract at the quoted fill."""
        return self.in_amount / self.out_amount


async def request_order(
    http: httpx.AsyncClient, settings: Settings, outcome_mint: str, wallet: str, spend_usd: float
) -> Order:
    """Ask DFlow for a v0 transaction that spends `spend_usd` USDC on `outcome_mint`."""
    headers = {"x-api-key": settings.dflow_api_key} if settings.dflow_api_key else {}
    resp = await http.get(
        f"{settings.dflow_trade_url}/order",
        params={
            "inputMint": USDC_MINT,
            "outputMint": outcome_mint,
            "amount": int(round(spend_usd * TOKEN_SCALE)),
            "userPublicKey": wallet,
            "slippageBps": "auto",
            "predictionMarketSlippageBps": "auto",
            "dynamicComputeUnitLimit": "true",
            "transactionVersion": "v0",
        },
        headers=headers,
        timeout=30,
    )
    if resp.status_code != 200:
        raise OrderError(f"DFlow /order {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    if not body.get("transaction"):
        raise OrderError("DFlow /order returned a quote without a transaction")
    out_amount = int(body["outAmount"])
    if out_amount <= 0:
        raise OrderError("DFlow /order quoted zero output")
    return Order(
        tx_base64=body["transaction"],
        in_amount=int(body["inAmount"]),
        out_amount=out_amount,
        min_out_amount=int(body.get("minOutAmount") or body.get("otherAmountThreshold") or 0),
        execution_mode=body.get("executionMode", ""),
        compute_unit_limit=body.get("computeUnitLimit"),
        last_valid_block_height=body.get("lastValidBlockHeight"),
    )
