#!/usr/bin/env python3
"""
MiniMax API Weight Tuner for AIThink.hx
Reads current weights → analyzes game structure → asks MiniMax for optimized weights → updates AIThink.hx

Usage:
  python tune_weights.py                    # analyze & suggest (dry run)
  python tune_weights.py --apply           # actually update AIThink.hx
  python tune_weights.py --num-battles 50  # run 50 battles before tuning
"""

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import requests

# ─── Configuration ───────────────────────────────────────────────
PROJECT_DIR = Path(r"D:\haxe\test")
AITHINK_PATH = PROJECT_DIR / "ai" / "AIThink.hx"
API_KEY_FILE = Path.home() / ".minimax_api_key"
MINIMAX_MODEL = "MiniMax-Text-01"

# Default fallback API key (if no key file found)
DEFAULT_API_KEY = ""

# ─── Weight extraction ────────────────────────────────────────────
def extract_weights(hx_content: str) -> Dict[str, float]:
    """Extract current weights from AIThink.hx"""
    weights = {}
    patterns = {
        "WEIGHT_DAMAGE": r'WEIGHT_DAMAGE:Float\s*=\s*([\d.]+)',
        "WEIGHT_HEAL": r'WEIGHT_HEAL:Float\s*=\s*([\d.]+)',
        "WEIGHT_SHIELD": r'WEIGHT_SHIELD:Float\s*=\s*([\d.]+)',
        "WEIGHT_POISON": r'WEIGHT_POISON:Float\s*=\s*([\d.]+)',
        "WEIGHT_DOUBLE_STAR": r'WEIGHT_DOUBLE_STAR:Float\s*=\s*([\d.]+)',
        "WEIGHT_ZERO_COMBO": r'WEIGHT_ZERO_COMBO:Float\s*=\s*([\d.]+)',
        "WEIGHT_SIX_COMBO": r'WEIGHT_SIX_COMBO:Float\s*=\s*([\d.]+)',
        "WEIGHT_ZERO_RISK": r'WEIGHT_ZERO_RISK:Float\s*=\s*([\d.]+)',
        "WEIGHT_ZERO_COUNTDOWN": r'WEIGHT_ZERO_COUNTDOWN:Float\s*=\s*([\d.]+)',
        "WEIGHT_OPP_ZERO_GOOD": r'WEIGHT_OPP_ZERO_GOOD:Float\s*=\s*([\d.]+)',
        "WEIGHT_HP_ADVANTAGE": r'WEIGHT_HP_ADVANTAGE:Float\s*=\s*([\d.]+)',
        "WEIGHT_HAND_QUALITY": r'WEIGHT_HAND_QUALITY:Float\s*=\s*([\d.]+)',
    }
    for name, pattern in patterns.items():
        match = re.search(pattern, hx_content)
        if match:
            weights[name] = float(match.group(1))
    return weights


def update_weights(hx_content: str, new_weights: Dict[str, float]) -> str:
    """Update weights in AIThink.hx"""
    for name, value in new_weights.items():
        pattern = rf'({name}:Float\s*=\s*)([\d.]+)'
        hx_content = re.sub(pattern, rf'\g<1>{value}', hx_content)
    return hx_content


# ─── Build / Compile ────────────────────────────────────────────────
def compile_haxe() -> bool:
    """Compile Haxe project"""
    print("[Tuner] Compiling Haxe project...")
    result = subprocess.run(
        ["haxe", "build.hxml"],
        cwd=str(PROJECT_DIR),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[Tuner] Compile error:\n{result.stderr}", file=sys.stderr)
        return False
    print("[Tuner] Compile successful")
    return True


# ─── MiniMax API ───────────────────────────────────────────────────
def get_api_key() -> str:
    """Get API key from file or environment"""
    if API_KEY_FILE.exists():
        return API_KEY_FILE.read_text().strip()
    import os
    return os.environ.get("MINIMAX_API_KEY", DEFAULT_API_KEY)


def call_minimax(system: str, user: str, api_key: str) -> str:
    """Call MiniMax API with messages"""
    if not api_key:
        print("[Tuner] No API key found. Provide via ~/.minimax_api_key or MINIMAX_API_KEY env", file=sys.stderr)
        sys.exit(1)

    url = "https://api.minimax.chat/v1/text/chatcompletion_v2"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MINIMAX_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": 4096,
        "temperature": 0.7,
    }

    print("[Tuner] Calling MiniMax API...")
    resp = requests.post(url, headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


# ─── Prompt builders ───────────────────────────────────────────────
GAME_CONTEXT = """You are an expert game AI designer for a 数学手指博弈 (Mathematical Finger Battle) game.

GAME RULES:
- 1v1 turn-based battle, each player has HP and 2 hands with values 0-9
- Touch mechanic: select one of your hands (A) + opponent's hand (B) → new value = (A+B)%10
- Various combos trigger based on hand values after combination:

COMBO TABLE:
- [x,x] double star: both hands equal → S-rank damage (highest damage)
- [0,x] zero combo by other hand value:
  * 0 → 150 damage (devastating)
  * 1,5,8,9 → 40 damage
  * 2,3 → 20 shield
  * 4,6 → 30 heal
  * 7 → 10 damage + poison
- [x,6]: hand becomes 6 → 30 heal

ZERO RULES:
- If both your hands become 0 at once → you instantly die
- Each 0-hand has a countdown (zeroTurns); when it reaches 0 → hand destroyed + HP damage
- Must avoid creating 0 when other hand already 0 (instant death)
- Zero is extremely powerful but risky

OTHER MECHANICS:
- Shield blocks incoming damage
- Poison deals damage over time each turn
- Various characters have unique abilities (XiaoQiao heals on 6, ZangShi uses cakes, etc.)

AI WEIGHT PARAMETERS (current values in Haxe AIThink.hx):
WEIGHT_DAMAGE:Float = 3.0        // Immediate damage benefit
WEIGHT_HEAL:Float = 2.0          // Immediate heal benefit
WEIGHT_SHIELD:Float = 1.5        // Immediate shield benefit
WEIGHT_POISON:Float = 1.2        // Immediate poison benefit
WEIGHT_DOUBLE_STAR:Float = 50.0  // Bonus for triggering double star combo
WEIGHT_ZERO_COMBO:Float = 25.0    // Bonus for creating zero combo potential
WEIGHT_SIX_COMBO:Float = 15.0    // Bonus for [x,6] combo potential
WEIGHT_ZERO_RISK:Float = -40.0   // Penalty for creating a Zero (very high risk)
WEIGHT_ZERO_COUNTDOWN:Float = -30.0 // Penalty for opponent having Zero with low countdown
WEIGHT_OPP_ZERO_GOOD:Float = 20.0 // Bonus when opponent has Zero (good opportunity)
WEIGHT_HP_ADVANTAGE:Float = 0.5  // Bonus for having more HP than opponent
WEIGHT_HAND_QUALITY:Float = 2.0   // Bonus for hand quality (proximity to combos)

EVALUATION FUNCTION:
The AI evaluates each possible move (myHand × opponentHand) using:
score  = immediateBenefit + comboPotential + riskAssessment + opponentThreat + characterBonus

- immediateBenefit: what this touch gains right now (damage/heal/shield/poison)
- comboPotential: how close this gets us to a combo (double star, zero, six)
- riskAssessment: danger of creating zero, or being in zero-countdown crisis
- opponentThreat: how vulnerable is opponent right now
- characterBonus: character-specific strategy bonuses

Your task: Given the current weights, analyze potential imbalances and suggest optimized weights."""


def build_optimization_prompt(current_weights: Dict[str, float]) -> tuple[str, str]:
    """Build prompt for weight optimization based on game theory"""
    system = GAME_CONTEXT

    weights_str = json.dumps(current_weights, indent=2)

    user = f"""Current AI weights:
{weights_str}

Analyze these weights for the 数学手指博弈 game and identify optimization opportunities:

CRITICAL ANALYSIS POINTS:
1. Zero Risk vs Zero Combo: WEIGHT_ZERO_RISK=-40 vs WEIGHT_ZERO_COMBO=25
   - Risk is much larger magnitude → AI should AVOID creating zero unless other hand value gives huge payoff (0,1,5,8,9)
   - Is the balance correct?

2. Double Star (50) vs Six Combo (15): 3.3x ratio
   - Double star is rarer but more powerful → is 50 enough vs 25 for zero combo?
   - Should zero combo be higher since it's also high risk?

3. HEAL weights: WEIGHT_HEAL=2, WEIGHT_SIX_COMBO=15
   - [x,6] gives 30 heal but WEIGHT_HEAL=2 (only contributes ~60 to score from heal alone)
   - But combo potential adds 15 → total ~75 for going to 6
   - Is this properly balanced vs WEIGHT_ZERO_COMBO=25 (which is riskier)?

4. WEIGHT_ZERO_COUNTDOWN=-30 for low opponent zero countdown
   - Should this be higher to pressure opponents in zero crisis?

5. Character-specific bonuses (last section of AIThink.hx) are small (+5 to +30)
   - Are these impactful enough given the overall evaluation scale?

Output format (JSON only, no markdown):
{{
  "analysis": "2-3 sentence analysis of the main weight imbalances",
  "optimized_weights": {{
    "WEIGHT_DAMAGE": float,
    "WEIGHT_HEAL": float,
    ...
  }},
  "reasoning": "2-3 sentences on the most important changes and why they help AI performance"
}}"""

    return system, user


# ─── Main tuning loop ──────────────────────────────────────────────
def tune(
    num_battles: int = 0,
    api_key: Optional[str] = None,
    dry_run: bool = True,
) -> bool:
    """Run one tuning iteration"""
    api_key = api_key or get_api_key()

    # 1. Load current weights
    hx_content = AITHINK_PATH.read_text(encoding="utf-8")
    current_weights = extract_weights(hx_content)
    if not current_weights:
        print("[Tuner] ERROR: Could not extract weights from AIThink.hx", file=sys.stderr)
        return False
    print(f"[Tuner] Current weights: {current_weights}")

    # 2. Compile (to ensure main.js is up to date)
    if not compile_haxe():
        return False

    # 3. Ask MiniMax to optimize weights
    sys_prompt, user_prompt = build_optimization_prompt(current_weights)
    response = call_minimax(sys_prompt, user_prompt, api_key)

    # 4. Parse JSON response
    try:
        # Try to extract JSON from response (in case there's extra text)
        json_match = re.search(r'\{[\s\S]*"optimized_weights"[\s\S]*\}', response)
        if json_match:
            response = json_match.group(0)
        data = json.loads(response)
    except (json.JSONDecodeError, TypeError) as e:
        print(f"[Tuner] Failed to parse MiniMax response: {e}", file=sys.stderr)
        print(f"[Tuner] Raw response (first 300 chars): {response[:300]}", file=sys.stderr)
        return False

    analysis = data.get("analysis", "No analysis provided")
    final_weights = data.get("optimized_weights", {})
    reasoning = data.get("reasoning", "No reasoning provided")

    print(f"\n[Tuner] MiniMax Analysis: {analysis}")
    print(f"[Tuner] Reasoning: {reasoning}")
    print(f"[Tuner] Suggested weights: {final_weights}")

    if dry_run:
        print(f"\n[Tuner] DRY RUN - no changes written. Use --apply to update AIThink.hx")
        return True

    # 5. Update AIThink.hx
    new_hx = update_weights(hx_content, final_weights)
    AITHINK_PATH.write_text(new_hx, encoding="utf-8")

    # 6. Backup old weights
    backup_path = PROJECT_DIR / "ai" / f"AIThink_weights_{datetime.now().strftime('%Y%m%d_%H%M%S')}.hx.bak"
    backup_path.write_text(hx_content, encoding="utf-8")
    print(f"[Tuner] Backup saved to {backup_path.name}")

    print(f"[Tuner] Updated AIThink.hx with optimized weights")
    return True


# ─── CLI ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Tune AIThink.hx weights via MiniMax API")
    parser.add_argument("-n", "--num-battles", type=int, default=0, help="Not used (for future battles)")
    parser.add_argument("-k", "--api-key", type=str, help="MiniMax API key")
    parser.add_argument("--apply", action="store_true", help="Actually write changes (default is dry-run)")
    args = parser.parse_args()

    success = tune(num_battles=args.num_battles, api_key=args.api_key, dry_run=not args.apply)
    sys.exit(0 if success else 1)