from __future__ import annotations

from autobid.models import Project


class ProposalError(ValueError):
    pass


class ProposalGenerator:
    def generate(self, project: Project, specifics: tuple[str, ...]) -> str:
        selected = tuple(dict.fromkeys(item.strip().lower() for item in specifics if item.strip()))[:3]
        if len(selected) < 2:
            raise ProposalError("proposal requires at least two project specifics")
        first, second = selected[:2]
        extra = f" I will also account for {selected[2]}." if len(selected) > 2 else ""
        proposal = (
            f"I can convert your {project.title.strip()} into a production-ready 2D file. "
            f"I will verify {first} and {second}, then check the exported geometry before delivery."
            f"{extra} I will use only the requirements and source files you provide."
        )
        return self.validate(proposal, project, selected)

    def validate(self, proposal: str, project: Project, specifics: tuple[str, ...]) -> str:
        normalized = proposal.lower()
        mentioned = sum(1 for item in set(specifics) if item.lower() in normalized)
        if mentioned < 2:
            raise ProposalError("proposal must mention at least two project specifics")
        if not proposal.strip() or len(proposal) > 1500:
            raise ProposalError("proposal must be non-empty and concise")
        return proposal.strip()

