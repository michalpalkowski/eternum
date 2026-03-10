import { ArmyList } from "./components/army-list";
import { useResolvedStructureEntityKey } from "@/hooks/helpers/use-resolved-structure-entity-key";
import { useDojo } from "@bibliothecadao/react";
import { ID } from "@bibliothecadao/types";
import { useComponentValue } from "@dojoengine/react";

export const Military = ({ entityId, className }: { entityId: ID | undefined; className?: string }) => {
  const {
    setup: { components },
  } = useDojo();
  const structureEntityKey = useResolvedStructureEntityKey(entityId ?? null);

  const structure = useComponentValue(components.Structure, structureEntityKey);

  return (
    <div className={`relative ${className}`}>
      {structure ? (
        <ArmyList structure={structure} />
      ) : (
        <div className="p-3 text-xxs text-gold/70">Select a realm to view armies.</div>
      )}
    </div>
  );
};
