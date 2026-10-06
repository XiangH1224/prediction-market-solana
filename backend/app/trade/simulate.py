import httpx

from ..config import TOKEN_SCALE, USDC_MINT, Settings
from ..models import SimulationReport
from .order import Order
from .rpc import associated_token_address, mint_token_program, rpc, token_amount, token_balances


async def simulate_order(
    http: httpx.AsyncClient, settings: Settings, order: Order, wallet: str, outcome_mint: str
) -> SimulationReport:
    """Dry-run the order against live state and check it does what the quote said.

    Nothing is signed or sent: sigVerify is off and the blockhash is replaced.
    """
    url = settings.solana_rpc_url
    outcome_program = await mint_token_program(http, url, outcome_mint)
    usdc_account = associated_token_address(wallet, USDC_MINT)
    outcome_account = associated_token_address(wallet, outcome_mint, outcome_program)
    addresses = [usdc_account, outcome_account]

    usdc_before, outcome_before = await token_balances(http, url, addresses)
    result = await rpc(
        http,
        url,
        "simulateTransaction",
        [
            order.tx_base64,
            {
                "encoding": "base64",
                "sigVerify": False,
                "replaceRecentBlockhash": True,
                "commitment": "confirmed",
                "accounts": {"encoding": "jsonParsed", "addresses": addresses},
            },
        ],
    )
    return check_simulation(result["value"], order, usdc_before, outcome_before, settings.max_compute_units)


def check_simulation(
    value: dict, order: Order, usdc_before: int, outcome_before: int, max_compute_units: int
) -> SimulationReport:
    failures: list[str] = []
    err = value.get("err")
    units = value.get("unitsConsumed")
    limit = order.compute_unit_limit or max_compute_units
    report = SimulationReport(
        ok=False,
        err=err,
        units_consumed=units,
        compute_unit_limit=limit,
        logs_tail=(value.get("logs") or [])[-6:],
    )

    if err is not None:
        failures.append(f"simulation error: {err}")
    if units is None:
        failures.append("simulation did not report compute units")
    elif units > min(limit, max_compute_units):
        failures.append(f"compute units {units} exceed limit {min(limit, max_compute_units)}")

    accounts = value.get("accounts")
    if err is None:
        if not accounts or len(accounts) != 2:
            failures.append("simulation did not return post-trade token accounts")
        else:
            usdc_delta = token_amount(accounts[0]) - usdc_before
            outcome_delta = token_amount(accounts[1]) - outcome_before
            report.usdc_delta = usdc_delta / TOKEN_SCALE
            report.outcome_delta = outcome_delta / TOKEN_SCALE

            if usdc_delta >= 0:
                failures.append("no USDC leaves the wallet")
            elif -usdc_delta > order.in_amount:
                failures.append(f"spends {-usdc_delta} USDC units, quote said at most {order.in_amount}")

            if order.execution_mode == "sync":
                report.fill_checked = True
                if outcome_delta < order.min_out_amount:
                    failures.append(
                        f"receives {outcome_delta} outcome units, quote guaranteed {order.min_out_amount}"
                    )

    report.failures = failures
    report.ok = not failures
    return report
